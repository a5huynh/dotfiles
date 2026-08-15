#!/usr/bin/env node
// Offline tests for hig.mjs — runs the CLI against a stub DocC API via
// HIG_API_BASE. No token, no network. Prints a request count at the end so a
// regression that re-fetches uncached pages is visible.
//
//   node test.mjs

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "hig.mjs");

// ------------------------------------------------------------------ fixtures

const para = (text) => ({ type: "paragraph", inlineContent: [{ type: "text", text }] });
const heading = (level, text) => ({ type: "heading", level, text, anchor: text });

const page = (title, slug, platforms, content, extra = {}) => ({
  abstract: [{ type: "text", text: `${title} abstract.` }],
  metadata: {
    title,
    role: "article",
    customMetadata: { "supported-platforms": platforms.join(","), ...extra },
  },
  primaryContentSections: [{ kind: "content", content }],
  references: {},
});

const section = (title, children) => ({
  abstract: [{ type: "text", text: `${title} abstract.` }],
  metadata: { title, role: "collection", customMetadata: {} },
  topicSections: [{ identifiers: children.map((c) => `doc://hig/${c.slug}`) }],
  references: Object.fromEntries(
    children.map((c) => [
      `doc://hig/${c.slug}`,
      {
        type: "topic",
        title: c.title,
        url: `/design/human-interface-guidelines/${c.slug}`,
        abstract: [{ type: "text", text: `${c.title} abstract.` }],
      },
    ]),
  ),
});

const BUTTONS = page(
  "Buttons",
  "buttons",
  ["ios", "ipados", "macos", "tvos"],
  [
    para("A button initiates an action."),
    heading(2, "Best practices"),
    para("Make buttons easy to use."),
    {
      type: "unorderedList",
      items: [{ content: [para("Style matters.")] }, { content: [para("Content matters.")] }],
    },
    {
      type: "aside",
      style: "note",
      name: "Note",
      content: [para("Tooltips appear on hover in macOS.")],
    },
    heading(2, "Platform considerations"),
    para("No additional considerations for tvOS."),
    heading(3, "iOS, iPadOS"),
    para("IOS_ONLY_MARKER activity indicator guidance."),
    heading(3, "macOS"),
    para("MACOS_ONLY_MARKER push button guidance."),
    heading(4, "Push buttons"),
    para("MACOS_SUBSECTION_MARKER."),
    heading(2, "Change log"),
    {
      type: "table",
      header: "row",
      rows: [
        [[para("Date")], [para("Changes")]],
        [[para("June 2025")], [para("Updated for Liquid Glass.")]],
      ],
    },
  ],
  { "alert-text": "Updated guidance for Liquid Glass.", "alert-date": "2025-12-16" },
);

const SHEETS = page("Sheets", "sheets", ["ios", "ipados"], [para("A sheet is a modal view.")]);
const MENUS = page("Menus", "menus", ["macos"], [para("A menu lists commands.")], {
  "alert-text": "Updated menu icons.",
  "alert-date": "2026-06-08",
});

const PAGES = {
  _root: section("Human Interface Guidelines", [
    { slug: "components", title: "Components" },
    { slug: "foundations", title: "Foundations" },
  ]),
  components: section("Components", [
    { slug: "buttons", title: "Buttons" },
    { slug: "sheets", title: "Sheets" },
  ]),
  foundations: section("Foundations", [{ slug: "menus", title: "Menus" }]),
  buttons: BUTTONS,
  sheets: SHEETS,
  menus: MENUS,
};

// -------------------------------------------------------------------- runner

let requests = 0;
const server = createServer((req, res) => {
  requests += 1;
  const path = req.url.replace(/^\/hig/, "").replace(/\.json$/, "").replace(/^\//, "");
  const doc = PAGES[path === "" ? "_root" : path];
  if (!doc) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<!doctype html>not found");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(doc));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/hig`;
const cacheDir = await mkdtemp(join(tmpdir(), "hig-test-"));

function run(args, { cache = cacheDir } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, HIG_API_BASE: base, HIG_CACHE_DIR: cache } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const has = (out, needle, msg) => assert(out.includes(needle), msg ?? `expected to find ${needle}`);
const lacks = (out, needle, msg) =>
  assert(!out.includes(needle), msg ?? `expected NOT to find ${needle}`);

// --------------------------------------------------------------------- tests

process.stdout.write("hig.mjs\n");

await test("show renders markdown structure", async () => {
  const { stdout, code } = await run(["show", "buttons"]);
  assert(code === 0, `exit ${code}`);
  has(stdout, "# Buttons");
  has(stdout, "## Best practices");
  has(stdout, "- Style matters.");
  has(stdout, "> **Note**");
  has(stdout, "| Date | Changes |");
  has(stdout, "Recent change: Updated guidance for Liquid Glass. (2025-12-16)");
  has(stdout, "Platforms: ios, ipados, macos, tvos");
});

await test("show defaults to iOS and drops other platform sections", async () => {
  const { stdout } = await run(["show", "buttons"]);
  has(stdout, "IOS_ONLY_MARKER");
  lacks(stdout, "MACOS_ONLY_MARKER", "macOS section leaked into iOS output");
  lacks(stdout, "MACOS_SUBSECTION_MARKER", "macOS level-4 subsection leaked into iOS output");
  has(stdout, "Filtered to iOS", "missing the note explaining what was dropped");
});

await test("'No additional considerations for tvOS' is dropped for iOS", async () => {
  const { stdout } = await run(["show", "buttons"]);
  lacks(stdout, "No additional considerations", "tvOS-only line leaked into iOS output");
});

await test("'No additional considerations for tvOS' is kept for tvOS", async () => {
  const { stdout } = await run(["show", "buttons", "--platform", "tvos"]);
  has(stdout, "No additional considerations for tvOS.");
  lacks(stdout, "IOS_ONLY_MARKER");
});

await test("--platform macos keeps macOS and its subsections", async () => {
  const { stdout } = await run(["show", "buttons", "-p", "macos"]);
  has(stdout, "MACOS_ONLY_MARKER");
  has(stdout, "MACOS_SUBSECTION_MARKER");
  lacks(stdout, "IOS_ONLY_MARKER");
});

await test("--platform all keeps everything and adds no filter note", async () => {
  const { stdout } = await run(["show", "buttons", "--platform", "all"]);
  has(stdout, "IOS_ONLY_MARKER");
  has(stdout, "MACOS_ONLY_MARKER");
  lacks(stdout, "Filtered to");
});

await test("content outside Platform considerations is never filtered", async () => {
  const { stdout } = await run(["show", "buttons", "-p", "watchos"]);
  has(stdout, "## Best practices");
  has(stdout, "Make buttons easy to use.");
  has(stdout, "| Date | Changes |", "Change log after a filtered section was swallowed");
});

await test("index crawls the whole tree", async () => {
  const { stdout } = await run(["index", "--json"]);
  const entries = JSON.parse(stdout);
  const slugs = entries.map((e) => e.slug).sort();
  assert(
    JSON.stringify(slugs) ===
      JSON.stringify(["buttons", "components", "foundations", "menus", "sheets"]),
    `unexpected slugs: ${slugs.join(",")}`,
  );
  const buttons = entries.find((e) => e.slug === "buttons");
  assert(buttons.section === "Components", `bad section: ${buttons.section}`);
  assert(buttons.platforms.includes("ios"), "platforms not captured");
});

await test("search ranks exact slug first", async () => {
  const { stdout } = await run(["search", "buttons"]);
  has(stdout, "buttons");
  assert(stdout.indexOf("buttons") < stdout.indexOf("Read one with"), "ordering looks wrong");
});

await test("search filters by platform", async () => {
  const ios = await run(["search", "menus"]);
  has(ios.stdout, "No HIG pages match", "macOS-only page surfaced under the iOS default");
  const mac = await run(["search", "menus", "-p", "macos"]);
  has(mac.stdout, "menus");
});

await test("list groups by section and honors platform", async () => {
  const { stdout } = await run(["list", "--platform", "all", "--json"]);
  const entries = JSON.parse(stdout);
  assert(entries.length === 5, `expected 5 pages, got ${entries.length}`);
});

await test("updated reports change notices, newest first", async () => {
  const { stdout } = await run(["updated", "--platform", "all"]);
  has(stdout, "2026-06-08");
  has(stdout, "2025-12-16");
  assert(stdout.indexOf("2026-06-08") < stdout.indexOf("2025-12-16"), "not sorted newest first");
});

await test("updated --since filters by date", async () => {
  const { stdout } = await run(["updated", "--platform", "all", "--since", "2026-01-01"]);
  has(stdout, "2026-06-08");
  lacks(stdout, "2025-12-16");
});

await test("unknown page exits 1 with suggestions", async () => {
  const { code, stderr } = await run(["show", "buton"]);
  assert(code === 1, `expected exit 1, got ${code}`);
  has(stderr, "Did you mean");
  has(stderr, "buttons");
});

await test("slug accepts a full URL", async () => {
  const { stdout, code } = await run([
    "show",
    "https://developer.apple.com/design/human-interface-guidelines/buttons",
  ]);
  assert(code === 0, `exit ${code}`);
  has(stdout, "# Buttons");
});

await test("bad platform is rejected", async () => {
  const { code, stderr } = await run(["show", "buttons", "-p", "androidos"]);
  assert(code === 1, `expected exit 1, got ${code}`);
  has(stderr, "unknown platform");
});

await test("cache prevents refetching", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "hig-cache-"));
  await run(["show", "buttons"], { cache: isolated });
  const before = requests;
  await run(["show", "buttons"], { cache: isolated });
  assert(requests === before, `cached read still made ${requests - before} request(s)`);
  await rm(isolated, { recursive: true, force: true });
});

// -------------------------------------------------------------------- teardown

await rm(cacheDir, { recursive: true, force: true });
server.close();

process.stdout.write(`\n${passed} passed, ${failures.length} failed — ${requests} stub requests\n`);
process.exit(failures.length ? 1 : 0);
