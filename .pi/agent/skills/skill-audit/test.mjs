// Offline exercise of skill-audit: a self-terminating stub of the TypeSafe System One
// endpoint plus a fixture catalog on disk. No API key, no network, no model.
//
// Run: node .pi/agent/skills/skill-audit/test.mjs

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "skill-audit.mjs");

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond ? "" : `  ${detail}`}`);
  if (!cond) failures++;
};

// ------------------------------------------------------- unit: frontmatter

const { parseFrontmatter } = await import(cli);

console.log("\n=== frontmatter parser ===");
{
  const folded = parseFrontmatter(`---
name: typesafe-ai
license: MIT
description: >
  Build AI-powered software with TypeSafe: small units of AI intelligence you
  can use like programming primitives.

  Second paragraph stays separate.
---
# body
`);
  check("folded '>' joins wrapped lines with a space",
    folded.description.startsWith("Build AI-powered software with TypeSafe: small units of AI intelligence you can use"),
    JSON.stringify(folded.description?.slice(0, 60)));
  check("folded '>' keeps paragraph break", folded.description.includes("\nSecond paragraph"));
  check("sibling key still parsed", folded.name === "typesafe-ai" && folded.license === "MIT");

  const literal = parseFrontmatter("---\nname: x\ndescription: |\n  line one\n  line two\n---\n");
  check("literal '|' preserves newlines", literal.description === "line one\nline two", JSON.stringify(literal.description));

  const quoted = parseFrontmatter(`---\nname: "q"\ndescription: 'has: a colon'\n---\n`);
  check("quotes stripped", quoted.name === "q" && quoted.description === "has: a colon");

  check("no frontmatter → null", parseFrontmatter("# just markdown\n") === null);
  check("unterminated frontmatter → null", parseFrontmatter("---\nname: x\n") === null);
}

// ------------------------------------------------------------- fixtures

const root = mkdtempSync(join(tmpdir(), "skill-audit-test-"));
const skill = (name, description, style = "plain", extra = "") => {
  mkdirSync(join(root, name), { recursive: true });
  const desc =
    style === "folded" ? `description: >\n  ${description}` :
    style === "literal" ? `description: |\n  ${description}` :
    `description: ${description}`;
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n${desc}\n${extra}---\n\n# ${name}\n`);
};

skill("review", "Review uncommitted changes in the current working tree before landing them.", "folded");
skill("review-pr", "Review a specific pull request or branch that is not the current working tree.");
skill("dnsimple", "Search for available domain names via the DNSimple registrar API.", "literal");
skill("plane", "Create and update work items in a self-hosted Plane instance.");
// The model can never auto-pick this, so it must not count as a routing conflict.
skill("pr", "Push current branch and create a GitHub pull request.", "plain", "disable-model-invocation: true\n");
// Underscored user_invocable gates the *user*, not the model — must NOT be excluded.
skill("docs", "Look up programming documentation and API references.", "plain", "user_invocable: false\n");
// A directory with no SKILL.md, and one with no description — both must be skipped.
mkdirSync(join(root, "not-a-skill"), { recursive: true });
writeFileSync(join(root, "not-a-skill", "README.md"), "nope\n");
mkdirSync(join(root, "no-desc"), { recursive: true });
writeFileSync(join(root, "no-desc", "SKILL.md"), "---\nname: no-desc\n---\n");

// ----------------------------------------------------------- stub server

const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    seen.push(payload);
    const answers = {};
    const request = String(payload.state?.user_request ?? "");

    for (const [id, q] of Object.entries(payload.questions ?? {})) {
      if (q.type === "noul") {
        // Overlap nouls name both skills; call the review pair confusable and nothing else.
        const ins = String(q.instructions);
        const pairHit = ins.includes('"review"') && ins.includes('"review-pr"');
        const needsSkill = /domain|\btaken\b|\.com\b|pull request|work item|ticket|diff/i.test(request);
        answers[id] = { type: "noul", noul: id === "needs_skill" ? (needsSkill ? 0.9 : 0.1) : pairHit ? 0.88 : 0.12 };
      } else if (q.type === "choice") {
        const names = Object.keys(q.criteria);
        // Deterministic keyword routing so assertions are stable.
        const want =
          /pull request|\bPR\b/i.test(request) ? "review-pr" :
          /diff|working tree|uncommitted/i.test(request) ? "review" :
          /domain|\btaken\b|\.com\b/i.test(request) ? "dnsimple" :
          /work item|ticket/i.test(request) ? "plane" :
          "(none)";
        const winner = names.includes(want) ? want : "(none)";
        // "narrow" is the interesting case: give review/review-pr a thin margin.
        const thin = winner === "review-pr" || winner === "review";
        const other = winner === "review-pr" ? "review" : "review-pr";
        const probabilities = {};
        for (const n of names) probabilities[n] = 0.01;
        probabilities[winner] = thin ? 0.44 : 0.9;
        if (thin && names.includes(other)) probabilities[other] = 0.40;
        const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
        for (const n of names) probabilities[n] = probabilities[n] / sum;
        answers[id] = { type: "choice", choice: winner, probabilities, confidence: thin ? 0.41 : 0.87 };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-stub", answers, usage: { input_tokens: 500, output_tokens: 20 } }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const env = {
  ...process.env,
  TYPESAFE_API_TOKEN: "stub",
  TYPESAFE_API_BASE: `http://127.0.0.1:${port}`,
  NO_COLOR: "1",
};

async function cli_(args, expectCode = 0) {
  try {
    const { stdout } = await run("node", [cli, ...args, "--dir", root, "--no-color"], { env });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

// ---------------------------------------------------------------- cases

console.log("\n=== catalog (no API calls) ===");
{
  const { out } = await cli_(["catalog"]);
  process.stdout.write(out);
  check("finds the 5 model-invocable skills", /5 skills/.test(out), out.slice(0, 80));
  check("skips dir without SKILL.md", !out.includes("not-a-skill"));
  check("skips SKILL.md without description", !out.includes("no-desc"));
  check("excludes disable-model-invocation by default", !/^\s+pr\s/m.test(out), "pr should be hidden");
  check("keeps underscored user_invocable skills", /docs/.test(out));
  check("made no API calls", seen.length === 0, `saw ${seen.length}`);

  const manual = await cli_(["catalog", "--include-manual"]);
  check("--include-manual brings it back", /6 skills/.test(manual.out) && /^\s+pr\s/m.test(manual.out), manual.out.slice(0, 80));
}

console.log("\n=== overlap ===");
{
  const before = seen.length;
  const { out, code } = await cli_(["overlap"]);
  process.stdout.write(out);
  check("flags the review / review-pr pair", /review\s+↔\s+review-pr|review-pr/.test(out));
  check("reports 1 pair above threshold", /1 pair\(s\) at or above/.test(out));
  check("exits 1 when a pair is flagged", code === 1, `code ${code}`);
  check("no pair involves the manual-only skill", !/\bpr\s+↔|↔\s+pr\b/.test(out));
  check("batched all 10 pairs into one request", seen.length - before === 1, `${seen.length - before} requests`);
  const q = seen[seen.length - 1].questions;
  check("noul instructions name both skills (ids are not sent)",
    Object.values(q).every((v) => (v.instructions.match(/"/g) || []).length >= 4));
  check("catalog rides in state, not in every question", Array.isArray(seen[seen.length - 1].state.skills));
}

console.log("\n=== route ===");
{
  const { out } = await cli_(["route", "review PR 983"]);
  process.stdout.write(out);
  check("picks review-pr for a PR prompt", /winner review-pr/.test(out));
  check("prints a distribution bar", /0\.\d{3}/.test(out));
  check("marks the narrow margin", /narrow/.test(out));
}

console.log("\n=== audit ===");
{
  const prompts = join(root, "prompts.json");
  writeFileSync(prompts, JSON.stringify([
    { prompt: "review PR 983", expect: "review-pr" },
    { prompt: "is example.com taken?", expect: "dnsimple" },
    { prompt: "what's the weather like today?", expect: null },
    { prompt: "file a ticket for the login bug", expect: "plane" },
  ]));
  const { out, code } = await cli_(["audit", "--prompts", prompts]);
  process.stdout.write(out);
  check("correct-but-thin routes flagged narrow", /narrow/.test(out));
  check("no false fire on the chit-chat prompt", /ok\s+\(none\)/.test(out) || /ok .*want \(none\)/.test(out));
  // review-pr, dnsimple and plane each win a prompt; docs and review never do.
  check("reports never-selected skills", /never selected: docs, review$/m.test(out), out.match(/never selected:.*/)?.[0] ?? "(absent)");
  check("exits 0 with no mismatches", code === 0, `code ${code}`);
}

console.log("\n=== invoked through a symlink ===");
{
  // Skills are installed as symlinks into ~/.pi/agent/skills, so argv[1] is the link while
  // import.meta.url is already resolved. A raw comparison makes IS_MAIN false and the CLI
  // prints nothing at all. This is how it is actually run, so it has to be covered.
  const linkDir = mkdtempSync(join(tmpdir(), "skill-audit-link-"));
  const link = join(linkDir, "skill-audit.mjs");
  symlinkSync(cli, link);
  const { stdout } = await run("node", [link, "catalog", "--dir", root, "--no-color"], { env });
  check("CLI still produces output via a symlink", /5 skills/.test(stdout), JSON.stringify(stdout.slice(0, 60)));
  rmSync(linkDir, { recursive: true, force: true });
}

console.log("\n=== error handling ===");
{
  const { out, code } = await cli_(["audit"]);
  check("audit without --prompts fails cleanly", code === 2 && /needs --prompts/.test(out), `code ${code}`);
  const bad = await cli_(["bogus"]);
  check("unknown command fails cleanly", bad.code === 2 && /unknown command/.test(bad.out));
  const noKey = await run("node", [cli, "overlap", "--dir", root], {
    env: { ...env, TYPESAFE_API_TOKEN: "", TYPESAFE_API_KEY: "" },
  }).catch((e) => ({ code: e.code, stderr: e.stderr }));
  check("missing key is reported, not a crash", noKey.code === 2 && /is not set/.test(noKey.stderr ?? ""), noKey.stderr ?? "");
}

server.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"} — ${seen.length} stub API calls\n`);
process.exit(failures ? 1 : 0);
