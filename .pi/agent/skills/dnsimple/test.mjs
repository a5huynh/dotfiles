// Self-terminating stub of the DNSimple API to exercise the skill end-to-end.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TAKEN = new Set(["barfly.com", "getbarfly.com", "barfly.net"]);
const seen = [];

const server = createServer((req, res) => {
  seen.push(req.url);
  const json = (o, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/whoami") return json({ data: { account: { id: 42, email: "a@b.c", plan_identifier: "personal" }, user: null } });

  let m = url.pathname.match(/^\/42\/registrar\/domains\/([^/]+)\/check$/);
  if (m) {
    const domain = decodeURIComponent(m[1]);
    if (domain.endsWith(".zzz")) return json({ message: "TLD .zzz is not supported" }, 400);
    return json({ data: { domain, available: !TAKEN.has(domain), premium: domain === "barfly.ai" } });
  }
  m = url.pathname.match(/^\/42\/registrar\/domains\/([^/]+)\/prices$/);
  if (m) {
    const domain = decodeURIComponent(m[1]);
    return json({ data: { domain, premium: domain === "barfly.ai", registration_price: domain === "barfly.ai" ? 2500 : 14, renewal_price: 18, transfer_price: 14, trustee_price: null } });
  }
  if (url.pathname === "/tlds") return json({ data: [{ tld: "bar", registration_enabled: true }, { tld: "com", registration_enabled: true }, { tld: "gov", registration_enabled: false }], pagination: { total_pages: 1 } });
  json({ message: "not found" }, 404);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const env = { ...process.env, DNSIMPLE_TOKEN: "stub", DNSIMPLE_API_BASE: `http://127.0.0.1:${port}` };
const cli = `${process.env.HOME}/.pi/agent/skills/dnsimple/dnsimple.mjs`;

async function show(label, args, extraEnv = {}) {
  console.log(`\n=== ${label} : ${args.join(" ")} ===`);
  try {
    const { stdout } = await run("node", [cli, ...args], { env: { ...env, ...extraEnv } });
    process.stdout.write(stdout);
  } catch (e) {
    console.log(`[exit ${e.code}] ${e.stdout || ""}${e.stderr || ""}`);
  }
}

await show("search default tlds", ["search", "barfly", "--tlds", "com,net,io,ai,zzz", "--all"]);
await show("search with affixes + prices", ["search", "barfly", "--prefix", "get,my", "--tlds", "com", "--prices"]);
await show("accepts a full domain as input", ["search", "barfly.com", "--all"]);
await show("check + json", ["check", "barfly.com", "barfly.io", "--json"]);
await show("prices", ["prices", "barfly.ai"]);
await show("tlds filter", ["tlds", "co"]);
await show("whoami", ["whoami"]);
await show("DNSIMPLE_ACCOUNT skips whoami", ["check", "barfly.io"], { DNSIMPLE_ACCOUNT: "42" });
await show("bad command", ["frobnicate"]);

console.log(`\n=== whoami calls made: ${seen.filter((u) => u === "/whoami").length} of ${seen.length} requests ===`);
server.close();
