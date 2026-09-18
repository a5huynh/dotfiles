#!/usr/bin/env node

// Audits an agent skill catalog for routing ambiguity, using TypeSafe's System One API.
//
// An agent picks a skill from name + description alone. Two descriptions that read alike
// are a silent bug: nothing fails, the wrong skill just loads. This asks the model the
// same question the agent faces, and reports where the catalog is ambiguous.
//
// `overlap` needs no test prompts — it reads the catalog and asks, for every pair, whether
// one request could plausibly match both. Pairs ride as parallel Nouls in one request:
// state is ingested once and every question is evaluated against it (see the fan-out
// pattern), so the whole matrix costs about as much as the catalog itself.

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Running as a CLI vs imported by test.mjs, which unit-tests the frontmatter parser.
// Without this guard an import would fall into main(), print usage and exit.
//
// Both sides must be realpath'd. Skills are installed as symlinks into ~/.pi/agent/skills,
// so argv[1] is the link while import.meta.url is already resolved to the repo — comparing
// them raw makes IS_MAIN false and the CLI silently prints nothing when run the documented
// way. Caught only by running through the installed symlink rather than the repo path.
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

const DEFAULT_BASE = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const NONE = "(none)";

const HOSTS = {
  pi: join(homedir(), ".pi/agent/skills"),
  claude: join(homedir(), ".claude/skills"),
};

const USAGE = `Usage:
  skill-audit.mjs catalog [--host pi|claude|both] [--dir PATH] [--json]
  skill-audit.mjs overlap [--host …] [--threshold 0.75] [--json]
  skill-audit.mjs route <prompt...> [--host …] [--json]
  skill-audit.mjs audit  [--prompts FILE] [--host …] [--json]

Commands:
  catalog   List discovered skills and description sizes. No API calls.
  overlap   Pairwise: could one request plausibly match both skills? Needs no prompts.
  route     Show the full probability distribution for one or more prompts.
  audit     Run a prompt set, then report mismatches, dead skills and false fires.

Options:
  --host <which>     pi | claude | both            (default: pi)
  --dir <path>       Audit an explicit directory of <name>/SKILL.md instead of --host
  --threshold <n>    Flag pairs at or above this noul                 (default: 0.75)
  --include-manual   Include skills with disable-model-invocation: true
  --margin <n>       Flag a route whose top-two gap is under this     (default: 0.15)
  --max-desc <n>     Truncate descriptions to n chars (0 = no limit)  (default: 0)
  --chunk <n>        Max questions per request                        (default: 40)
  --model <name>     Model to send                                    (default: ${DEFAULT_MODEL})
  --json             Emit JSON instead of tables
  --no-color         Disable ANSI colour

Environment:
  TYPESAFE_API_KEY    Required. Also accepts TYPESAFE_API_TOKEN.
  TYPESAFE_API_BASE   Optional. Override API base URL (proxy/testing).
  TYPESAFE_MODEL      Optional. Default model.

Exit status is 1 when audit/overlap finds a problem, so it can gate a commit.

Prompts file: JSON array of {"prompt": "...", "expect": "skill-name" | null}.
A null/absent expect means no skill should fire.`;

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const opts = {
  host: "pi",
  dir: null,
  // A noul at 0.5 is maximum uncertainty (equal probability for yes and no), not "medium
  // overlap" — thresholding there flags the model's shrugs. 0.75 is where it is actually
  // asserting the pair collides; tune against your own catalog.
  threshold: 0.75,
  includeManual: false,
  margin: 0.15,
  maxDesc: 0,
  chunk: 40,
  model: process.env.TYPESAFE_MODEL || DEFAULT_MODEL,
  json: false,
  color: process.stdout.isTTY && !process.env.NO_COLOR,
  prompts: null,
};
const positional = [];

const num = (s, fallback) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--host": opts.host = argv[++i] ?? "pi"; break;
    case "--dir": opts.dir = argv[++i] ?? null; break;
    case "--threshold": opts.threshold = num(argv[++i], 0.75); break;
    case "--include-manual": opts.includeManual = true; break;
    case "--margin": opts.margin = num(argv[++i], 0.15); break;
    case "--max-desc": opts.maxDesc = num(argv[++i], 0); break;
    case "--chunk": opts.chunk = Math.max(1, num(argv[++i], 40)); break;
    case "--model": opts.model = argv[++i] ?? DEFAULT_MODEL; break;
    case "--prompts": opts.prompts = argv[++i] ?? null; break;
    case "--json": opts.json = true; break;
    case "--no-color": opts.color = false; break;
    case "-h": case "--help": console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith("--")) fail(`unknown option: ${a}`);
      positional.push(a);
  }
}

function fail(msg, code = 2) {
  console.error(`skill-audit: ${msg}`);
  process.exit(code);
}

const C = {
  dim: (s) => (opts.color ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (opts.color ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s) => (opts.color ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (opts.color ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s) => (opts.color ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s) => (opts.color ? `\x1b[36m${s}\x1b[0m` : s),
};

// ------------------------------------------------------------ frontmatter

// Minimal YAML frontmatter reader: enough for `name` and `description`, including the
// folded (`>`) and literal (`|`) block scalars that skills commonly use for long
// descriptions. Deliberately not a YAML parser — a dependency would be the alternative.
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return null;
  const close = text.indexOf("\n---", firstNl);
  if (close === -1) return null;

  const lines = text.slice(firstNl + 1, close).split("\n");
  const out = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }

    const m = line.match(/^([A-Za-z0-9_.-]+):[ \t]*(.*)$/);
    if (!m) { i++; continue; }
    const [, key, rawVal] = m;
    const block = rawVal.match(/^([>|])([+-]?)$/);

    if (block) {
      const folded = block[1] === ">";
      const collected = [];
      i++;
      let indent = null;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") { collected.push(""); i++; continue; }
        const lead = l.match(/^[ \t]*/)[0].length;
        if (lead === 0) break;
        if (indent === null) indent = lead;
        collected.push(l.slice(Math.min(lead, indent)));
        i++;
      }
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      if (folded) {
        // Blank lines are paragraph breaks; runs of text join with a space.
        const paras = [];
        let buf = [];
        for (const l of collected) {
          if (l === "") { if (buf.length) { paras.push(buf.join(" ")); buf = []; } }
          else buf.push(l.trim());
        }
        if (buf.length) paras.push(buf.join(" "));
        out[key] = paras.join("\n");
      } else {
        out[key] = collected.join("\n");
      }
      continue;
    }

    let val = rawVal.trim();
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    i++;
  }
  return out;
}

// -------------------------------------------------------------- catalog

// Third-party SKILL.md content reaches two sinks: a skill name is interpolated into the
// model's *instruction* channel in cmdOverlap, and a description is printed straight to a
// terminal by cmdCatalog. The scanned directories hold brew-owned, npx-installed and
// externally managed skills, so constrain both here at the boundary rather than at each
// point of use. Real skill names already sit inside this character set.
const safeName = (s) => String(s).replace(/[^\w.-]+/g, "-").slice(0, 64) || "unnamed";
const sanitizeText = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

function readSkillDir(dir, host) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    // Skills are symlinked in this setup, so isDirectory() must follow the link.
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try { isDir = statSync(path).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    const md = join(path, "SKILL.md");
    if (!existsSync(md)) continue;
    let fm;
    try { fm = parseFrontmatter(readFileSync(md, "utf8")); } catch { continue; }
    if (!fm || !fm.description) continue;
    found.push({
      name: safeName(fm.name || e.name),
      dir: e.name,
      host,
      path: md,
      // A skill the model cannot auto-invoke is never in the running, so counting it as a
      // routing conflict is noise. Note this is the hyphenated key; peon-ping's underscored
      // `user_invocable` is a different thing (it gates the *user*, not the model).
      modelInvocable: String(fm["disable-model-invocation"] ?? "").trim() !== "true",
      description: sanitizeText(fm.description),
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function loadCatalog() {
  if (opts.dir) {
    const dir = resolve(opts.dir);
    if (!existsSync(dir)) fail(`no such directory: ${dir}`);
    return readSkillDir(dir, "dir");
  }
  const hosts = opts.host === "both" ? ["pi", "claude"] : [opts.host];
  const out = [];
  for (const h of hosts) {
    if (!HOSTS[h]) fail(`unknown host: ${h} (want pi, claude or both)`);
    out.push(...readSkillDir(HOSTS[h], h));
  }
  if (opts.host === "both") {
    // The same skill can be symlinked into both hosts; keep one entry, note both.
    const byName = new Map();
    for (const s of out) {
      const prev = byName.get(s.name);
      if (prev) prev.host = `${prev.host}+${s.host}`;
      else byName.set(s.name, { ...s });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

const clip = (s) => (opts.maxDesc > 0 && s.length > opts.maxDesc ? `${s.slice(0, opts.maxDesc)}…` : s);

// --------------------------------------------------------- typesafe client

const apiKey = process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_TOKEN || "";
const apiBase = (process.env.TYPESAFE_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");

let totalIn = 0, totalOut = 0, requests = 0;

async function systemOne(state, questions, { attempt = 0 } = {}) {
  if (!apiKey) fail("TYPESAFE_API_KEY (or TYPESAFE_API_TOKEN) is not set");
  const res = await fetch(`${apiBase}/v1/systemone`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state, model: opts.model, questions }),
  });

  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
    await new Promise((r) => setTimeout(r, waitMs));
    return systemOne(state, questions, { attempt: attempt + 1 });
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text).message || JSON.parse(text).error || msg; } catch {}
    fail(`API ${res.status}: ${msg}`, 3);
  }
  const body = JSON.parse(text);
  requests++;
  totalIn += body.usage?.input_tokens ?? 0;
  totalOut += body.usage?.output_tokens ?? 0;
  return body;
}

// Send one question map in chunks, so a large matrix does not blow the context budget.
async function askChunked(state, questions) {
  const ids = Object.keys(questions);
  const answers = {};
  for (let i = 0; i < ids.length; i += opts.chunk) {
    const slice = ids.slice(i, i + opts.chunk);
    const sub = {};
    for (const id of slice) sub[id] = questions[id];
    const body = await systemOne(state, sub);
    Object.assign(answers, body.answers || {});
  }
  return answers;
}

const catalogState = (skills) => ({
  skills: skills.map((s) => ({ name: s.name, description: clip(s.description) })),
});

// ------------------------------------------------------------- commands

function cmdCatalog(skills) {
  if (opts.json) return void console.log(JSON.stringify(skills, null, 2));
  console.log(C.bold(`\n${skills.length} skills — ${opts.dir ? opts.dir : opts.host}\n`));
  const w = Math.max(...skills.map((s) => s.name.length), 4);
  for (const s of skills) {
    const chars = String(s.description.length).padStart(5);
    console.log(`  ${s.name.padEnd(w)}  ${C.dim(`${chars} chars`)}  ${C.dim(s.host)}`);
  }
  const total = skills.reduce((a, s) => a + s.description.length, 0);
  console.log(C.dim(`\n  ${total} description chars total, ${skills.length * (skills.length - 1) / 2} pairs\n`));
}

async function cmdOverlap(skills) {
  if (skills.length < 2) fail("need at least 2 skills to compare");
  const pairs = [];
  for (let i = 0; i < skills.length; i++)
    for (let j = i + 1; j < skills.length; j++) pairs.push([skills[i], skills[j]]);

  // Question ids are not sent to the model, so each instruction names both skills in full.
  const questions = {};
  pairs.forEach(([a, b], idx) => {
    questions[`p${idx}`] = {
      type: "noul",
      instructions:
        `In the skills catalog above, could a single realistic user request plausibly ` +
        `match BOTH the skill named "${a.name}" and the skill named "${b.name}", such that ` +
        `an agent choosing between them from their descriptions alone could pick the wrong one?`,
      criteria: {
        true: "The two descriptions overlap; a real request could fit either, and the wrong one could be chosen.",
        false: "The descriptions are clearly distinct; a request matching one would not match the other.",
      },
    };
  });

  const answers = await askChunked(catalogState(skills), questions);
  const scored = pairs.map(([a, b], idx) => ({ a: a.name, b: b.name, noul: answers[`p${idx}`]?.noul ?? null }));
  const rows = scored.filter((r) => r.noul !== null).sort((x, y) => y.noul - x.noul);
  // A pair with no answer is "not checked", not "no overlap". Dropping it silently under a
  // header that still claims the full count turns an incomplete run into a clean bill of
  // health — and a green gate. Report it, and exit non-zero.
  const unchecked = scored.length - rows.length;

  const flagged = rows.filter((r) => r.noul >= opts.threshold);
  if (opts.json) {
    console.log(JSON.stringify({ threshold: opts.threshold, pairs: rows, flagged: flagged.length, unchecked, usage: { requests, input_tokens: totalIn } }, null, 2));
    return flagged.length || unchecked ? 1 : 0;
  }

  console.log(C.bold(`\nPairwise overlap — ${skills.length} skills, ${pairs.length} pairs\n`));
  const w = Math.max(...rows.map((r) => r.a.length));
  const shown = rows.slice(0, Math.max(flagged.length, 8));
  for (const r of shown) {
    const mark = r.noul >= opts.threshold ? C.red("▲") : C.dim("·");
    const val = r.noul >= opts.threshold ? C.red(r.noul.toFixed(2)) : C.dim(r.noul.toFixed(2));
    console.log(`  ${val}  ${mark}  ${r.a.padEnd(w)}  ${C.dim("↔")}  ${r.b}`);
  }
  if (rows.length > shown.length) console.log(C.dim(`  … ${rows.length - shown.length} more below threshold`));
  if (unchecked) console.log(C.red(`\n  ${unchecked} pair(s) NOT CHECKED — no answer returned for them`));
  console.log(
    flagged.length
      ? C.yellow(`\n  ${flagged.length} pair(s) at or above ${opts.threshold} — descriptions may need disambiguating\n`)
      : C.green(`\n  no pairs at or above ${opts.threshold}\n`),
  );
  reportUsage();
  return flagged.length || unchecked ? 1 : 0;
}

function routeQuestions(skills) {
  const criteria = { [NONE]: "No skill in the catalog is needed; the request is ordinary conversation or plain work." };
  for (const s of skills) criteria[s.name] = clip(s.description);
  return {
    pick: {
      type: "choice",
      instructions: "Which single skill from the catalog best fits the user request in the state? Choose (none) if no skill genuinely applies.",
      criteria,
    },
    needs_skill: {
      type: "noul",
      instructions: "Does answering this user request actually require one of the catalog's specialised skills, rather than ordinary assistant work?",
      criteria: { true: "A specialised skill is genuinely needed.", false: "Ordinary work; no skill required." },
    },
  };
}

async function routeOne(skills, prompt) {
  const state = { skills: catalogState(skills).skills, user_request: prompt };
  const body = await systemOne(state, routeQuestions(skills));
  const pick = body.answers?.pick ?? {};
  const probs = pick.probabilities ?? {};
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  return {
    prompt,
    winner: pick.choice ?? null,
    confidence: pick.confidence ?? null,
    margin: top && second ? top[1] - second[1] : null,
    needsSkill: body.answers?.needs_skill?.noul ?? null,
    ranked,
  };
}

async function cmdRoute(skills, prompts) {
  const results = [];
  for (const p of prompts) results.push(await routeOne(skills, p));
  if (opts.json) return void console.log(JSON.stringify({ results, usage: { requests, input_tokens: totalIn } }, null, 2));

  for (const r of results) {
    console.log(`\n${C.bold(`"${r.prompt}"`)}\n`);
    const w = Math.max(...r.ranked.slice(0, 6).map(([n]) => n.length));
    for (const [name, p] of r.ranked.slice(0, 6)) {
      if (p < 0.005) continue;
      const bar = "█".repeat(Math.round(p * 28));
      const label = name === r.winner ? C.cyan(name.padEnd(w)) : name.padEnd(w);
      console.log(`  ${label}  ${p.toFixed(3)}  ${C.dim(bar)}`);
    }
    const flag = r.margin !== null && r.margin < opts.margin ? C.yellow("  ← narrow") : "";
    console.log(
      C.dim(`\n  winner ${r.winner}   confidence ${fmt(r.confidence)}   margin ${fmt(r.margin)}   needs-skill ${fmt(r.needsSkill)}`) + flag,
    );
  }
  console.log();
  reportUsage();
  return 0;
}

async function cmdAudit(skills, promptsFile) {
  if (!promptsFile) fail("audit needs --prompts FILE (see prompts.example.json)");
  let cases;
  try {
    cases = JSON.parse(readFileSync(resolve(promptsFile), "utf8"));
  } catch (e) {
    fail(`cannot read prompts file: ${e.message}`);
  }
  if (!Array.isArray(cases)) fail("prompts file must be a JSON array");

  const known = new Set(skills.map((s) => s.name));
  cases.forEach((c, idx) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) fail(`prompts[${idx}] is not an object`);
    // `prompt` was previously unvalidated while `expect` was, so a typo'd key crashed on
    // r.prompt.slice() at render time — after the API call had already been paid for.
    if (typeof c.prompt !== "string" || !c.prompt.trim()) fail(`prompts[${idx}] has no non-empty "prompt" string`);
    if (c.expect && !known.has(c.expect)) fail(`prompts[${idx}] expects unknown skill "${c.expect}"`);
  });

  const results = [];
  for (const c of cases) {
    const r = await routeOne(skills, c.prompt);
    // `||`, not `??`: an empty-string expect is falsy so it skips the known-skill check
    // above, and `??` would let it through as "" — an expectation no winner can ever equal,
    // reported forever as a mismatch.
    const expect = c.expect || null;
    const fired = r.winner && r.winner !== NONE;
    let verdict;
    if (expect === null) verdict = fired ? "false-fire" : "ok";
    else if (r.winner === expect) verdict = r.margin !== null && r.margin < opts.margin ? "narrow" : "ok";
    else verdict = "mismatch";
    results.push({ ...r, expect, verdict });
  }

  const won = new Set(results.map((r) => r.winner).filter((n) => n && n !== NONE));
  const dead = skills.map((s) => s.name).filter((n) => !won.has(n));
  const bad = results.filter((r) => r.verdict === "mismatch" || r.verdict === "false-fire");
  const narrow = results.filter((r) => r.verdict === "narrow");

  if (opts.json) {
    console.log(JSON.stringify({ results, dead, problems: bad.length, narrow: narrow.length, usage: { requests, input_tokens: totalIn } }, null, 2));
    return bad.length ? 1 : 0;
  }

  console.log(C.bold(`\nRouting audit — ${cases.length} prompts against ${skills.length} skills\n`));
  const w = Math.max(...results.map((r) => (r.winner || "").length), 8);
  for (const r of results) {
    const tag = { ok: C.green("ok       "), narrow: C.yellow("narrow   "), mismatch: C.red("mismatch "), "false-fire": C.red("false-fire") }[r.verdict];
    const exp = r.expect === null ? NONE : r.expect;
    console.log(`  ${tag} ${(r.winner || "—").padEnd(w)} ${C.dim(`want ${exp}`)}  ${C.dim(`m=${fmt(r.margin)}`)}  ${r.prompt.slice(0, 44)}`);
  }
  if (narrow.length) console.log(C.yellow(`\n  ${narrow.length} correct but narrow (top-two gap < ${opts.margin}) — fragile, could flip`));
  if (dead.length) console.log(C.dim(`\n  never selected: ${dead.join(", ")}`));
  console.log(bad.length ? C.red(`\n  ${bad.length} problem(s)\n`) : C.green(`\n  no problems\n`));
  reportUsage();
  return bad.length ? 1 : 0;
}

const fmt = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));

function reportUsage() {
  if (!requests) return;
  // Jev bills input tokens only; output is free. Price per Mtok from docs.typesafe.ai/models.
  const cost = (totalIn / 1_000_000) * 0.042;
  console.log(C.dim(`  ${requests} request(s), ${totalIn} input tokens ≈ $${cost.toFixed(6)}\n`));
}

// ----------------------------------------------------------------- main

if (IS_MAIN) {
  const cmd = positional.shift();
  if (!cmd) { console.log(USAGE); process.exit(0); }

  const all = loadCatalog();
  const skills = opts.includeManual ? all : all.filter((s) => s.modelInvocable);
  const skipped = all.length - skills.length;
  if (skipped && !opts.json) {
    console.error(C.dim(`  (${skipped} skill(s) skipped: disable-model-invocation — pass --include-manual to keep)`));
  }
  if (!skills.length) fail(`no skills with a description found in ${opts.dir || HOSTS[opts.host] || opts.host}`);

  let code = 0;
  switch (cmd) {
    case "catalog": cmdCatalog(skills); break;
    case "overlap": code = await cmdOverlap(skills); break;
    case "route":
      if (!positional.length) fail("route needs at least one prompt");
      code = await cmdRoute(skills, positional);
      break;
    case "audit": code = await cmdAudit(skills, opts.prompts); break;
    default: fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
  process.exit(code);
}
