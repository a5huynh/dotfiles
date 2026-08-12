#!/usr/bin/env node

// DNSimple domain availability search.
// Uses the DNSimple API v2 registrar check endpoint (one request per domain),
// so candidates are generated locally and checked through a bounded pool.

const HOSTS = {
  prod: "https://api.dnsimple.com/v2",
  sandbox: "https://api.sandbox.dnsimple.com/v2",
};

const DEFAULT_TLDS = ["com", "net", "org", "io", "dev", "app", "co", "sh", "xyz", "ai"];

const USAGE = `Usage:
  dnsimple.mjs search <name...> [--tlds com,io] [--prefix get,my] [--suffix app,hq] [options]
  dnsimple.mjs check <domain...> [options]
  dnsimple.mjs prices <domain...> [options]
  dnsimple.mjs tlds [filter]
  dnsimple.mjs whoami

Options:
  --tlds <list>      Comma-separated TLDs (search only). Default: ${DEFAULT_TLDS.join(",")}
  --prefix <list>    Comma-separated prefixes to prepend to each name
  --suffix <list>    Comma-separated suffixes to append to each name
  --prices           Fetch registration/renewal prices for available domains
  --all              Show taken domains too (default: available only)
  --json             Emit JSON instead of a table
  --concurrency <n>  Parallel requests (default: 6)
  --sandbox          Use api.sandbox.dnsimple.com
  --research         Use the domains/research/status endpoint (private beta)

Environment:
  DNSIMPLE_TOKEN     Required. Account API token (Account > Access tokens).
  DNSIMPLE_ACCOUNT   Optional. Account id; skips the /whoami lookup.
  DNSIMPLE_API_BASE  Optional. Override the API base URL (proxy/testing).`;

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const opts = {
  tlds: null,
  prefix: [],
  suffix: [],
  prices: false,
  all: false,
  json: false,
  concurrency: 6,
  sandbox: false,
  research: false,
};
const positional = [];

const list = (s) => s.split(",").map((p) => p.trim()).filter(Boolean);

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--tlds": opts.tlds = list(argv[++i] ?? ""); break;
    case "--prefix": opts.prefix = list(argv[++i] ?? ""); break;
    case "--suffix": opts.suffix = list(argv[++i] ?? ""); break;
    case "--concurrency": opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 6); break;
    case "--prices": opts.prices = true; break;
    case "--all": opts.all = true; break;
    case "--json": opts.json = true; break;
    case "--sandbox": opts.sandbox = true; break;
    case "--research": opts.research = true; break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("--")) fail(`Unknown option: ${a}\n\n${USAGE}`);
      positional.push(a);
  }
}

const command = positional.shift();
if (!command) fail(USAGE);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ------------------------------------------------------------------- http

const base = process.env.DNSIMPLE_API_BASE || HOSTS[opts.sandbox ? "sandbox" : "prod"];

function token() {
  const t = process.env.DNSIMPLE_TOKEN;
  if (!t) {
    fail(
      "DNSIMPLE_TOKEN is not set.\n" +
      "Create an account API token at https://dnsimple.com/a/account/access_tokens\n" +
      "then: export DNSIMPLE_TOKEN=…"
    );
  }
  return t;
}

class ApiError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

async function api(path, { retry = true } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      "User-Agent": "pi-agent-dnsimple-skill/1.0",
    },
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "unknown";
    const msg = body?.message ?? "";

    // A per-endpoint quota (e.g. "endpoint checkDomain quota exceeded") is hourly and
    // far smaller than the account limit — retrying in a couple of seconds cannot help,
    // and the x-ratelimit-* headers don't track it, so they can't be used to predict it.
    if (/quota exceeded/i.test(msg)) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new ApiError(429, `${msg}; resets at ${when}` +
        (remaining ? ` (account limit is fine: ${remaining} left — this is a separate per-endpoint quota)` : ""), res.headers);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 2000));
      return api(path, { retry: false });
    }
    throw new ApiError(429, `Rate limited; resets at ${when}`, res.headers);
  }

  if (!res.ok) {
    if (res.status === 401) throw new ApiError(401, "Unauthorized — check DNSIMPLE_TOKEN", res.headers);
    throw new ApiError(res.status, body?.message || `HTTP ${res.status}`, res.headers);
  }
  return body;
}

// Cache the in-flight promise, not the resolved id: the checks run concurrently, so
// caching only the result lets every worker miss an empty cache and race its own
// /whoami — doubling request count against the 2,400/hour limit.
let accountPromise = null;
function account() {
  return (accountPromise ??= resolveAccount());
}

async function resolveAccount() {
  if (process.env.DNSIMPLE_ACCOUNT) return process.env.DNSIMPLE_ACCOUNT;
  const who = await api("/whoami");
  const id = who?.data?.account?.id;
  if (!id) {
    fail(
      "This token resolves to a user, not an account, so account-scoped calls can't be built.\n" +
      "Use an *account* API token, or set DNSIMPLE_ACCOUNT=<account id>."
    );
  }
  return id;
}

// ------------------------------------------------------------------- helpers

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function candidates(names) {
  const tlds = (opts.tlds ?? DEFAULT_TLDS).map((t) => t.replace(/^\./, "").toLowerCase());
  const prefixes = ["", ...opts.prefix];
  const suffixes = ["", ...opts.suffix];
  const out = new Set();
  for (const raw of names) {
    // Accept "barfly" or "barfly.com" — a supplied TLD becomes part of the TLD set.
    const dot = raw.lastIndexOf(".");
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const own = dot > 0 ? [raw.slice(dot + 1).toLowerCase()] : [];
    for (const p of prefixes) {
      for (const s of suffixes) {
        const label = `${p}${stem}${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!label) continue;
        for (const tld of own.length ? own : tlds) out.add(`${label}.${tld}`);
      }
    }
  }
  return [...out];
}

// Set when a fatal error (quota/auth) makes every remaining request pointless. Work already
// done is still worth reporting, so the pool drains into `skipped` instead of throwing.
let aborted = null;

async function checkOne(domain) {
  if (aborted) return { domain, skipped: true };
  const acct = await account();
  try {
    if (opts.research) {
      const r = await api(`/${acct}/domains/research/status?domain=${encodeURIComponent(domain)}`);
      const d = r?.data ?? {};
      return {
        domain,
        available: d.availability === "available",
        premium: false,
        availability: d.availability ?? "unknown",
        errors: d.errors ?? [],
      };
    }
    const r = await api(`/${acct}/registrar/domains/${encodeURIComponent(domain)}/check`);
    const d = r?.data ?? {};
    return { domain, available: !!d.available, premium: !!d.premium };
  } catch (e) {
    // Fatal for the run, but don't discard results already collected.
    if (e.status === 429 || e.status === 401) {
      aborted ??= e;
      return { domain, skipped: true };
    }
    return { domain, error: e.message };
  }
}

async function priceOne(domain) {
  // Only auth failures are fatal everywhere. A checkDomain quota lockout must NOT suppress
  // pricing: it's a separate endpoint with a separate quota, and still answers normally.
  if (aborted?.status === 401) return null;
  const acct = await account();
  try {
    const r = await api(`/${acct}/registrar/domains/${encodeURIComponent(domain)}/prices`);
    return r?.data ?? null;
  } catch {
    return null; // prices are a nice-to-have; never fail a search over them
  }
}

const money = (n) => (n == null ? "" : `$${Number(n).toFixed(2)}`);

function report(rows) {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const available = rows.filter((r) => r.available);
  const taken = rows.filter((r) => !r.available && !r.error && !r.skipped);
  const errored = rows.filter((r) => r.error);
  const skipped = rows.filter((r) => r.skipped);
  const width = Math.max(0, ...rows.map((r) => r.domain.length));
  const pad = (s) => s.padEnd(width);

  if (available.length) {
    console.log(`AVAILABLE (${available.length})`);
    for (const r of available) {
      const notes = [];
      if (r.premium) notes.push("PREMIUM");
      if (r.prices) {
        notes.push(`${money(r.prices.registration_price)} reg`);
        if (r.prices.renewal_price !== r.prices.registration_price) {
          notes.push(`${money(r.prices.renewal_price)} renew`);
        }
      }
      console.log(`  ${pad(r.domain)}${notes.length ? "  " + notes.join(" · ") : ""}`.trimEnd());
    }
  } else {
    console.log("AVAILABLE (0)");
  }

  if (opts.all && taken.length) {
    console.log(`\nTAKEN (${taken.length})`);
    for (const r of taken) console.log(`  ${pad(r.domain)}${r.availability ? "  " + r.availability : ""}`.trimEnd());
  } else if (taken.length) {
    console.log(`\n${taken.length} taken (--all to list)`);
  }

  if (errored.length) {
    console.log(`\nERRORS (${errored.length})`);
    for (const r of errored) console.log(`  ${pad(r.domain)}  ${r.error}`);
  }

  if (skipped.length) {
    console.log(`\nNOT CHECKED (${skipped.length}) — ${aborted?.message ?? "run aborted"}`);
    for (const r of skipped) console.log(`  ${r.domain}`);
    console.log(`\n  Re-run just these after the reset:`);
    console.log(`  check ${skipped.map((r) => r.domain).join(" ")}`);
  }
}

async function runCheck(domains) {
  if (!domains.length) fail(USAGE);
  const rows = await pool(domains, opts.concurrency, checkOne);
  if (opts.prices) {
    const avail = rows.filter((r) => r.available);
    const prices = await pool(avail, opts.concurrency, (r) => priceOne(r.domain));
    avail.forEach((r, i) => { r.prices = prices[i]; });
  }
  rows.sort((a, b) => Number(!!b.available) - Number(!!a.available) || a.domain.localeCompare(b.domain));
  report(rows);
  if (aborted) process.exitCode = 1;
}

// ------------------------------------------------------------------- commands

try {
  switch (command) {
    case "search":
      await runCheck(candidates(positional));
      break;

    case "check":
      await runCheck(positional);
      break;

    case "prices": {
      if (!positional.length) fail(USAGE);
      const rows = await pool(positional, opts.concurrency, async (d) => ({ domain: d, prices: await priceOne(d) }));
      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); break; }
      for (const { domain, prices: p } of rows) {
        if (!p) { console.log(`${domain}  (no price available)`); continue; }
        console.log(
          `${domain}  ${money(p.registration_price)} reg · ${money(p.renewal_price)} renew · ` +
          `${money(p.transfer_price)} transfer${p.premium ? " · PREMIUM" : ""}`
        );
      }
      break;
    }

    case "tlds": {
      const filter = (positional[0] ?? "").toLowerCase();
      const all = [];
      for (let page = 1; ; page++) {
        const r = await api(`/tlds?per_page=100&page=${page}`);
        all.push(...(r?.data ?? []));
        if (page >= (r?.pagination?.total_pages ?? 1)) break;
      }
      const rows = all.filter((t) => !filter || t.tld.includes(filter));
      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); break; }
      console.log(`${rows.length} TLD(s)${filter ? ` matching "${filter}"` : ""}:`);
      const names = rows.map((t) => (t.registration_enabled ? `.${t.tld}` : `.${t.tld} (no reg)`));
      console.log(names.join("  "));
      break;
    }

    case "whoami": {
      const who = await api("/whoami");
      if (opts.json) { console.log(JSON.stringify(who?.data ?? {}, null, 2)); break; }
      const a = who?.data?.account, u = who?.data?.user;
      if (a) console.log(`account ${a.id}  ${a.email}  plan=${a.plan_identifier ?? "?"}`);
      if (u) console.log(`user    ${u.id}  ${u.email}`);
      if (!a && !u) console.log("no identity returned");
      break;
    }

    default:
      fail(`Unknown command: ${command}\n\n${USAGE}`);
  }
} catch (e) {
  fail(`Error: ${e.message}`);
}
