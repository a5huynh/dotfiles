#!/usr/bin/env node
// Apple Human Interface Guidelines reader.
//
// The HIG is a Swift-DocC site; every page has a JSON twin under
// /tutorials/data/... that holds structured content blocks. We render those to
// markdown rather than scraping HTML.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const API_BASE =
  process.env.HIG_API_BASE ??
  "https://developer.apple.com/tutorials/data/design/human-interface-guidelines";
const SITE_BASE = "https://developer.apple.com/design/human-interface-guidelines";
const CACHE_DIR = process.env.HIG_CACHE_DIR ?? join(tmpdir(), "hig-cache");

const PAGE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const PLATFORMS = ["ios", "ipados", "macos", "tvos", "visionos", "watchos"];
const PLATFORM_LABEL = {
  ios: "iOS",
  ipados: "iPadOS",
  macos: "macOS",
  tvos: "tvOS",
  visionos: "visionOS",
  watchos: "watchOS",
};

// ---------------------------------------------------------------- fetch/cache

function slugify(input) {
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/[^/]+/, "");
  s = s.replace(/^\/?design\/human-interface-guidelines\/?/i, "");
  s = s.replace(/\.json$/i, "").replace(/^\/+|\/+$/g, "");
  return s.toLowerCase();
}

async function readCache(file, ttl) {
  try {
    const raw = await readFile(file, "utf8");
    const { cachedAt, data } = JSON.parse(raw);
    if (Date.now() - cachedAt > ttl) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ cachedAt: Date.now(), data }));
}

async function fetchPage(slug, { refresh = false } = {}) {
  const key = slug === "" ? "_root" : slug.replace(/\//g, "__");
  const file = join(CACHE_DIR, "pages", `${key}.json`);
  if (!refresh) {
    const hit = await readCache(file, PAGE_TTL_MS);
    if (hit) return hit;
  }
  const url = slug === "" ? `${API_BASE}.json` : `${API_BASE}/${slug}.json`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "hig-skill" },
  });
  if (res.status === 404) throw new NotFound(slug);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new NotFound(slug);
  const data = await res.json();
  await writeCache(file, data);
  return data;
}

class NotFound extends Error {
  constructor(slug) {
    super(`No HIG page named "${slug}"`);
    this.slug = slug;
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------- rendering

function renderInline(nodes, refs) {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.text ?? "";
        case "strong":
        case "inlineHead":
          return `**${renderInline(n.inlineContent, refs)}**`;
        case "emphasis":
        case "newTerm":
          return `*${renderInline(n.inlineContent, refs)}*`;
        case "codeVoice":
          return `\`${n.code ?? ""}\``;
        case "image":
          return "";
        case "link":
          return n.title ? `[${n.title}](${n.destination})` : (n.destination ?? "");
        case "reference": {
          const r = refs?.[n.identifier];
          const title = n.overridingTitle ?? r?.title ?? n.identifier;
          const url = r?.url ?? "";
          if (!url) return title;
          const abs = url.startsWith("http") ? url : `https://developer.apple.com${url}`;
          return `[${title}](${abs})`;
        }
        default:
          return n.inlineContent ? renderInline(n.inlineContent, refs) : (n.text ?? "");
      }
    })
    .join("");
}

function renderBlocks(blocks, refs, depth = 0) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(Math.min(b.level ?? 2, 6))} ${b.text ?? ""}`);
        break;
      case "paragraph": {
        const t = renderInline(b.inlineContent, refs).trim();
        if (t) out.push(t);
        break;
      }
      case "unorderedList":
        for (const item of b.items ?? []) {
          const inner = renderBlocks(item.content, refs, depth + 1).join("\n");
          out.push(indentList(inner, "-", depth));
        }
        break;
      case "orderedList":
        (b.items ?? []).forEach((item, i) => {
          const inner = renderBlocks(item.content, refs, depth + 1).join("\n");
          out.push(indentList(inner, `${i + 1}.`, depth));
        });
        break;
      case "termList":
        for (const item of b.items ?? []) {
          const term = renderInline(item.term?.inlineContent, refs).trim();
          const def = renderBlocks(item.definition?.content, refs, depth + 1).join(" ").trim();
          out.push(`- **${term}** — ${def}`);
        }
        break;
      case "aside": {
        const body = renderBlocks(b.content, refs, depth).join("\n");
        const label = b.name ?? b.style ?? "Note";
        out.push(
          `> **${label}**\n${body
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")}`,
        );
        break;
      }
      case "codeListing":
        out.push(`\`\`\`${b.syntax ?? ""}\n${(b.code ?? []).join("\n")}\n\`\`\``);
        break;
      case "table":
        out.push(renderTable(b, refs));
        break;
      case "row":
        for (const col of b.columns ?? []) out.push(...renderBlocks(col.content, refs, depth));
        break;
      case "tabNavigator":
        for (const tab of b.tabs ?? []) {
          out.push(`**${tab.title}**`);
          out.push(...renderBlocks(tab.content, refs, depth));
        }
        break;
      case "video":
      case "small":
        break;
      default:
        if (b.content) out.push(...renderBlocks(b.content, refs, depth));
        else if (b.inlineContent) {
          const t = renderInline(b.inlineContent, refs).trim();
          if (t) out.push(t);
        }
    }
  }
  return out;
}

function indentList(text, marker, depth) {
  const pad = "  ".repeat(depth);
  const lines = text.split("\n");
  return lines
    .map((l, i) => (i === 0 ? `${pad}${marker} ${l}` : `${pad}   ${l}`))
    .join("\n");
}

function renderTable(b, refs) {
  const rows = (b.rows ?? []).map((row) =>
    row.map((cell) => renderBlocks(cell, refs).join(" ").replace(/\|/g, "\\|").trim()),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const [head, ...body] = b.header === "row" ? norm : [Array(width).fill(""), ...norm];
  return [
    `| ${head.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

// Which platforms does a string like "iOS, iPadOS" or "No additional
// considerations for macOS or tvOS." name? Matches whole tokens only, so
// "visionOS" never counts as "iOS".
function namedPlatforms(text) {
  const found = new Set();
  for (const p of PLATFORMS) {
    const re = new RegExp(`(^|[^a-z])${PLATFORM_LABEL[p]}([^a-z]|$)`, "i");
    if (re.test(text)) found.add(p);
  }
  return found;
}

// Drop "Platform considerations" content that doesn't match the requested
// platform: level-3 headings like "iOS, iPadOS" / "macOS", plus the bare
// "No additional considerations for tvOS." paragraphs that sit between them.
function filterPlatform(lines, platform) {
  if (platform === "all") return { lines, dropped: [] };
  const out = [];
  const dropped = [];
  let skipping = false;
  let inPlatformSection = false;

  for (const line of lines) {
    const h = /^(#{2,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 2) {
        inPlatformSection = /^platform considerations$/i.test(text);
        skipping = false;
      } else if (inPlatformSection && level === 3) {
        const match = namedPlatforms(text).has(platform);
        skipping = !match;
        if (!match) dropped.push(text);
      }
    } else if (inPlatformSection && !skipping && /no additional considerations for/i.test(line)) {
      // Applies to the platforms it names, not to the section we're inside.
      const named = namedPlatforms(line);
      if (named.size && !named.has(platform)) continue;
    }
    if (!skipping) out.push(line);
  }
  return { lines: out, dropped };
}

function pageMeta(doc) {
  const cm = doc?.metadata?.customMetadata ?? {};
  const platforms = (cm["supported-platforms"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    title: doc?.metadata?.title ?? "",
    platforms,
    alertText: cm["alert-text"] ?? "",
    alertDate: cm["alert-date"] ?? "",
  };
}

function renderPage(doc, slug, { platform }) {
  const refs = doc.references ?? {};
  const meta = pageMeta(doc);
  const head = [`# ${meta.title}`, ""];
  const abstract = renderInline(doc.abstract, refs).trim();
  if (abstract) head.push(abstract, "");
  head.push(`Source: ${SITE_BASE}/${slug}`);
  if (meta.platforms.length) head.push(`Platforms: ${meta.platforms.join(", ")}`);
  if (meta.alertText) head.push(`Recent change: ${meta.alertText} (${meta.alertDate})`);
  head.push("");

  let body = [];
  for (const section of doc.primaryContentSections ?? []) {
    body.push(...renderBlocks(section.content, refs));
  }

  const topics = [];
  for (const s of doc.topicSections ?? []) {
    if (s.title) topics.push(`### ${s.title}`);
    for (const id of s.identifiers ?? []) {
      const r = refs[id];
      if (!r?.url) continue;
      const child = slugify(r.url);
      const abs = (r.abstract ? renderInline(r.abstract, refs) : "").trim();
      topics.push(`- \`${child}\` — ${r.title}${abs ? `: ${abs}` : ""}`);
    }
  }
  if (topics.length) body.push("## Pages in this section", ...topics);

  const { lines, dropped } = filterPlatform(body, platform);
  const footer = dropped.length
    ? [
        "",
        `_Filtered to ${PLATFORM_LABEL[platform]}: dropped platform sections for ${dropped.join(
          "; ",
        )}. Use --platform all to see them._`,
      ]
    : [];

  return [...head, ...lines, ...footer].join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- index

function childSlugs(doc) {
  const refs = doc.references ?? {};
  const kids = [];
  for (const s of doc.topicSections ?? []) {
    for (const id of s.identifiers ?? []) {
      const r = refs[id];
      if (!r?.url?.startsWith("/design/human-interface-guidelines/")) continue;
      kids.push({
        slug: slugify(r.url),
        title: r.title ?? "",
        abstract: (r.abstract ? renderInline(r.abstract, refs) : "").trim(),
      });
    }
  }
  return kids;
}

async function buildIndex({ refresh = false, quiet = false } = {}) {
  const log = (m) => !quiet && process.stderr.write(`${m}\n`);
  const pages = new Map();
  let frontier = [{ slug: "", title: "Human Interface Guidelines", abstract: "", section: "" }];
  let depth = 0;

  while (frontier.length && depth < 6) {
    const docs = await pool(frontier, 6, async (node) => {
      try {
        return await fetchPage(node.slug, { refresh });
      } catch {
        return null;
      }
    });
    const next = [];
    frontier.forEach((node, i) => {
      const doc = docs[i];
      if (!doc) return;
      const meta = pageMeta(doc);
      if (node.slug) {
        const existing = pages.get(node.slug);
        pages.set(node.slug, {
          slug: node.slug,
          title: meta.title || node.title,
          abstract: node.abstract || existing?.abstract || "",
          section: node.section,
          platforms: meta.platforms,
          alertText: meta.alertText,
          alertDate: meta.alertDate,
        });
      }
      for (const kid of childSlugs(doc)) {
        if (pages.has(kid.slug) || next.some((n) => n.slug === kid.slug)) continue;
        next.push({ ...kid, section: node.slug ? node.section || node.title : kid.title });
      }
    });
    log(`  depth ${depth}: ${frontier.length} fetched, ${next.length} new`);
    frontier = next;
    depth += 1;
  }

  const index = [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  await writeCache(join(CACHE_DIR, "index.json"), index);
  log(`Indexed ${index.length} HIG pages.`);
  return index;
}

async function loadIndex({ refresh = false } = {}) {
  if (!refresh) {
    const hit = await readCache(join(CACHE_DIR, "index.json"), INDEX_TTL_MS);
    if (hit) return hit;
    process.stderr.write("Building HIG page index (one-time, ~170 requests)…\n");
  }
  return buildIndex({ refresh });
}

// ---------------------------------------------------------------- commands

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// Substring scoring finds nothing for a typo like "buton", so fall back to
// edit distance against the slug and its individual words.
function suggest(index, query, limit = 8) {
  const q = query.toLowerCase();
  return index
    .map((e) => {
      const words = [e.slug, ...e.slug.split("-"), ...e.title.toLowerCase().split(/\s+/)];
      const best = Math.min(...words.map((w) => levenshtein(q, w)));
      return { e, dist: best };
    })
    .filter((h) => h.dist <= Math.max(2, Math.floor(q.length / 3)))
    .sort((a, b) => a.dist - b.dist || a.e.slug.localeCompare(b.e.slug))
    .slice(0, limit);
}

function scoreEntry(entry, terms) {
  const title = entry.title.toLowerCase();
  const slug = entry.slug.toLowerCase();
  const abstract = (entry.abstract ?? "").toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (slug === t || title === t) score += 100;
    else if (slug.includes(t)) score += 30;
    else if (title.includes(t)) score += 25;
    else if (abstract.includes(t)) score += 8;
    else return 0;
  }
  return score;
}

async function cmdSearch(args, opts) {
  const terms = args.map((a) => a.toLowerCase()).filter(Boolean);
  if (!terms.length) fail("search needs a query, e.g. `search sheet`");
  const index = await loadIndex({ refresh: opts.refresh });
  let hits = index
    .map((e) => ({ e, score: scoreEntry(e, terms) }))
    .filter((h) => h.score > 0);
  if (opts.platform !== "all") {
    hits = hits.filter((h) => !h.e.platforms.length || h.e.platforms.includes(opts.platform));
  }
  hits.sort((a, b) => b.score - a.score || a.e.slug.localeCompare(b.e.slug));
  const top = hits.slice(0, opts.limit);
  if (opts.json) return print(JSON.stringify(top.map((h) => h.e), null, 2));
  if (!top.length) return print(`No HIG pages match ${terms.join(" ")}.`);
  const lines = [`${hits.length} match${hits.length === 1 ? "" : "es"} for "${terms.join(" ")}":`, ""];
  for (const { e } of top) {
    lines.push(`  ${e.slug}${e.section ? `  (${e.section})` : ""}`);
    if (e.abstract) lines.push(`      ${e.abstract}`);
  }
  lines.push("", `Read one with:  hig.mjs show <slug>`);
  print(lines.join("\n"));
}

async function cmdShow(args, opts) {
  if (!args.length) fail("show needs a page, e.g. `show buttons`");
  const slug = slugify(args[0]);
  let doc;
  try {
    doc = await fetchPage(slug, { refresh: opts.refresh });
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    const index = await loadIndex();
    let near = index
      .map((e) => ({ e, score: scoreEntry(e, [slug]) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (!near.length) near = suggest(index, slug);
    const hint = near.length
      ? `\n\nDid you mean:\n${near.map((h) => `  ${h.e.slug}`).join("\n")}`
      : `\n\nRun \`hig.mjs search ${slug}\` to find the right page.`;
    fail(`No HIG page "${slug}".${hint}`);
  }
  if (opts.json) return print(JSON.stringify({ slug, ...pageMeta(doc), doc }, null, 2));
  print(renderPage(doc, slug, { platform: opts.platform }));
}

async function cmdList(args, opts) {
  const index = await loadIndex({ refresh: opts.refresh });
  const filter = args[0]?.toLowerCase();
  let entries = index;
  if (filter) entries = entries.filter((e) => (e.section ?? "").toLowerCase().includes(filter));
  if (opts.platform !== "all") {
    entries = entries.filter((e) => !e.platforms.length || e.platforms.includes(opts.platform));
  }
  if (opts.json) return print(JSON.stringify(entries, null, 2));
  const bySection = new Map();
  for (const e of entries) {
    const k = e.section || "Other";
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k).push(e);
  }
  const lines = [];
  for (const [section, items] of [...bySection].sort()) {
    lines.push(`${section} (${items.length})`);
    for (const e of items) lines.push(`  ${e.slug}`);
    lines.push("");
  }
  lines.push(`${entries.length} pages.`);
  print(lines.join("\n"));
}

async function cmdUpdated(args, opts) {
  const index = await loadIndex({ refresh: opts.refresh });
  const since = opts.since ?? "";
  let entries = index.filter((e) => e.alertText && (!since || e.alertDate >= since));
  if (opts.platform !== "all") {
    entries = entries.filter((e) => !e.platforms.length || e.platforms.includes(opts.platform));
  }
  entries.sort((a, b) => (b.alertDate ?? "").localeCompare(a.alertDate ?? ""));
  if (opts.json) return print(JSON.stringify(entries, null, 2));
  if (!entries.length) return print("No pages carry a change notice.");
  const lines = [`${entries.length} page(s) with recent guidance changes:`, ""];
  for (const e of entries) lines.push(`  ${e.alertDate}  ${e.slug}\n      ${e.alertText}`);
  print(lines.join("\n"));
}

async function cmdIndex(_args, opts) {
  await buildIndex({ refresh: true, quiet: opts.json });
  if (opts.json) print(JSON.stringify(await loadIndex(), null, 2));
}

// ---------------------------------------------------------------- cli

const USAGE = `Apple Human Interface Guidelines reader

Usage:
  hig.mjs search <query…>        Find HIG pages by keyword
  hig.mjs show <slug>            Print a page as markdown
  hig.mjs list [section]         List indexed pages, grouped by section
  hig.mjs updated [--since D]    Pages whose guidance recently changed
  hig.mjs index                  Rebuild the page index

Options:
  --platform <p>   ios (default), ipados, macos, tvos, visionos, watchos, all
  --limit N        Max search results (default 12)
  --since YYYY-MM-DD   Filter \`updated\` by date
  --refresh        Bypass the cache
  --json           Machine-readable output

Cache: ${CACHE_DIR}`;

function print(s) {
  process.stdout.write(`${s}\n`);
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { platform: "ios", limit: 12, json: false, refresh: false, since: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--platform" || a === "-p") {
      const v = String(argv[++i] ?? "").toLowerCase();
      if (v !== "all" && !PLATFORMS.includes(v)) {
        fail(`unknown platform "${v}". Use: ${[...PLATFORMS, "all"].join(", ")}`);
      }
      opts.platform = v;
    } else if (a === "--limit") opts.limit = Number(argv[++i]) || 12;
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--refresh") opts.refresh = true;
    else if (a === "-h" || a === "--help") {
      print(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

const COMMANDS = {
  search: cmdSearch,
  show: cmdShow,
  list: cmdList,
  updated: cmdUpdated,
  index: cmdIndex,
};

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    print(USAGE);
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) fail(`unknown command "${cmd}"\n\n${USAGE}`);
  const { opts, rest } = parseArgs(argv);
  await handler(rest, opts);
}

main().catch((err) => fail(err.message));
