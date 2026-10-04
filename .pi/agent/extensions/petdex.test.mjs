#!/usr/bin/env node
/**
 * Offline tests for petdex.ts. No pi host, no Petdex app, no network beyond a
 * loopback stub:
 *
 *   node .pi/agent/extensions/petdex.test.mjs
 *
 * Same shape as session-title.test.mjs — transpiled with the esbuild inside pi
 * and imported into a sandbox whose `node_modules` symlinks pi's own packages.
 * The Petdex hook server is a local HTTP stub that records every request, and
 * ~/.petdex/runtime is a temp dir (PETDEX_RUNTIME_DIR), so the token, the
 * killswitch and the exact wire bodies are all assertable.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ------------------------------------------------------------- sandbox ----

function findPiDir() {
	const bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
	const dir = dirname(dirname(dirname(bin))); // dist/bundle/cli.js -> package root
	assert.ok(existsSync(join(dir, "package.json")), `pi package not found at ${dir}`);
	return dir;
}

const PI_DIR = findPiDir();
const SANDBOX = mkdtempSync(join(tmpdir(), "petdex-test-"));
const RUNTIME = join(SANDBOX, "runtime");
const TOKEN = "test-token-0123456789";
mkdirSync(RUNTIME);

mkdirSync(join(SANDBOX, "node_modules", "@earendil-works"), { recursive: true });
symlinkSync(join(PI_DIR, "node_modules", "@earendil-works", "pi-tui"), join(SANDBOX, "node_modules", "@earendil-works", "pi-tui"));
symlinkSync(PI_DIR, join(SANDBOX, "node_modules", "@earendil-works", "pi-coding-agent"));

const BUILT = join(SANDBOX, "petdex.mjs");
execFileSync(join(PI_DIR, "node_modules", ".bin", "esbuild"), [
	join(import.meta.dirname, "petdex.ts"),
	"--format=esm",
	"--platform=node",
	"--target=node22",
	`--outfile=${BUILT}`,
	"--log-level=error",
]);

// ------------------------------------------------------------ stub app ----

/** Every request the stub received, in arrival order. */
const requests = [];
let responseDelayMs = 0;

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const authorized = req.headers["x-petdex-update-token"] === TOKEN;
		requests.push({ path: req.url, authorized, body: body ? JSON.parse(body) : undefined });
		setTimeout(() => {
			res.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" });
			res.end(authorized ? '{"ok":true}' : '{"ok":false}');
		}, responseDelayMs);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// Read at module load by the extension, so all of them precede the import.
const COALESCE_MS = 40;
// Whole seconds: the heartbeat text carries elapsed time, and must differ per beat.
const WAITING_MS = 1000;
process.env.PETDEX_HOOK_URL = `http://127.0.0.1:${server.address().port}`;
process.env.PETDEX_RUNTIME_DIR = RUNTIME;
process.env.PI_PETDEX_COALESCE_MS = String(COALESCE_MS);
process.env.PI_PETDEX_WAITING_MS = String(WAITING_MS);
process.env.HERDR_PANE_ID = "w3:p4M";
const { default: extension } = await import(BUILT);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let every queued post land: past the coalesce window and the request chain. */
const settle = () => sleep(COALESCE_MS * 3);

async function waitFor(predicate, what, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${what}`);
}

const bubbles = () => requests.filter((r) => r.path === "/bubble").map((r) => r.body);
const states = () => requests.filter((r) => r.path === "/state").map((r) => r.body);
const lastBubble = () => bubbles().at(-1);
const lastState = () => states().at(-1);

// ---------------------------------------------------------------- fakes ----

let nextSession = 0;
/** Every host built by the current test, shut down after it so no heartbeat leaks on. */
const hosts = [];

/** One extension instance plus the host surface it talks to. */
function host({ mode = "tui", entries = [], sessionId = `session-${++nextSession}` } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	let id = sessionId;

	extension({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
	});

	const ctx = {
		mode,
		hasUI: mode !== "print",
		cwd: "/work/repo",
		sessionManager: {
			getSessionId: () => id,
			getEntries: () => entries,
		},
		ui: { notify: (message, type) => notices.push({ message, type }) },
	};

	const fire = (event, payload = {}) => handlers.get(event)?.(payload, ctx);
	hosts.push(fire);

	return {
		handlers,
		commands,
		notices,
		ctx,
		fire,
		get id() {
			return id;
		},
		swap: (next) => {
			id = next;
		},
		tool: (toolName, input = {}) => fire("tool_call", { toolName, input }),
		result: (toolName, input = {}, isError = false) => fire("tool_result", { toolName, input, isError }),
	};
}

// ---------------------------------------------------------------- tests ----

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a read is posted as review, with the path relative to cwd", async () => {
	const h = host();
	h.tool("read", { path: "/work/repo/src/main.rs" });
	await waitFor(() => bubbles().length === 1, "one bubble");
	assert.equal(lastState().state, "review");
	assert.equal(lastBubble().text, "Reading src/main.rs");
	assert.equal(lastBubble().agent_state, "review");
});

test("the wire format carries pi's identity and the herdr pane", async () => {
	const h = host();
	h.tool("bash", { command: "cargo test" });
	await waitFor(() => bubbles().length === 1, "one bubble");
	const bubble = lastBubble();
	assert.equal(bubble.agent_source, "pi");
	assert.equal(bubble.session_id, h.id);
	assert.equal(bubble.conversation_key, h.id);
	assert.equal(bubble.herdr_pane_id, "w3:p4M", "click-to-focus needs the pane");
	assert.equal(bubble.source_cwd, "/work/repo");
	assert.equal(bubble.feed_source, "hook");
	assert.equal(lastState().state, "running");
	assert.equal(lastState().session_id, h.id);
	assert.ok(requests.every((r) => r.authorized), "every request carries the token");
});

test("a successful tool_result posts nothing", async () => {
	const h = host();
	h.result("bash", { command: "ls" });
	await settle();
	assert.equal(requests.length, 0);
});

test("a failed tool_result is posted as failed", async () => {
	const h = host();
	h.result("bash", { command: "cargo test" }, true);
	await waitFor(() => bubbles().length === 1, "one bubble");
	assert.equal(lastState().state, "failed");
	assert.equal(lastBubble().text, "Ran cargo test failed");
});

test("a burst of tool calls coalesces to leading + trailing, latest wins", async () => {
	const h = host();
	for (let i = 0; i < 10; i++) h.tool("read", { path: `/work/repo/file${i}.ts` });
	await settle();
	const texts = bubbles().map((b) => b.text);
	assert.deepEqual(texts, ["Reading file0.ts", "Reading file9.ts"]);
});

test("coalescing does not swallow a failure, and nothing stale lands after it", async () => {
	const h = host();
	h.tool("bash", { command: "first" });
	h.tool("bash", { command: "second" }); // queued behind the window
	h.result("bash", { command: "second" }, true);
	await settle();
	const texts = bubbles().map((b) => b.text);
	assert.deepEqual(texts, ["Running first", "Ran second failed"]);
});

test("agent_settled always lands, and last", async () => {
	const h = host();
	h.tool("read", { path: "a" });
	h.tool("read", { path: "b" });
	h.fire("agent_settled");
	await settle();
	assert.equal(lastBubble().text, "Done.");
	assert.equal(lastBubble().status, "completed");
	assert.equal(lastState().state, "waving");
	assert.ok(!bubbles().some((b) => b.text === "Reading b"), "the queued read must be dropped");
});

test("posts land in order even when the app is slow", async () => {
	responseDelayMs = 30;
	try {
		const h = host();
		h.fire("input", { text: "go" });
		h.result("bash", { command: "x" }, true);
		h.fire("agent_settled");
		await waitFor(() => bubbles().length === 3, "three bubbles");
		assert.deepEqual(
			bubbles().map((b) => b.event_kind),
			["user-prompt", "tool-failure", "session-end"],
		);
	} finally {
		responseDelayMs = 0;
	}
});

test("handlers never wait on the network", async () => {
	responseDelayMs = 250;
	try {
		const h = host();
		const started = Date.now();
		await h.fire("input", { text: "go" });
		await h.result("bash", { command: "x" }, true);
		await h.fire("agent_settled");
		assert.ok(Date.now() - started < 50, `handlers blocked for ${Date.now() - started}ms`);
		await waitFor(() => bubbles().length === 3, "three bubbles");
	} finally {
		responseDelayMs = 0;
	}
});

test("a blocking prompt waits, heartbeats with distinct text, and resolves", async () => {
	const h = host();
	h.fire("ui_prompt_start", { kind: "confirm", title: "Delete 3 files?" });
	await waitFor(() => bubbles().length >= 3, "two heartbeats", WAITING_MS * 3);
	const waiting = bubbles();
	assert.equal(waiting[0].text, "Waiting: Delete 3 files?");
	assert.equal(waiting[0].status, "needs_input");
	assert.equal(lastState().state, "waiting");
	const requestId = waiting[0].request_id;
	assert.ok(requestId, "waiting carries a request id");
	assert.ok(waiting.every((b) => b.request_id === requestId), "heartbeats repeat the same request");
	// The server suppresses an identical bubble without refreshing its recency.
	assert.equal(new Set(waiting.map((b) => b.text)).size, waiting.length, "every heartbeat must differ");

	h.fire("ui_prompt_end", { kind: "confirm" });
	await settle();
	assert.equal(lastBubble().resolves_request_id, requestId);
	assert.equal(lastBubble().status, "running");
	const count = bubbles().length;
	await sleep(WAITING_MS * 1.5);
	assert.equal(bubbles().length, count, "no heartbeat after the prompt resolves");
});

test("any new activity stops the waiting heartbeat", async () => {
	const h = host();
	h.fire("ui_prompt_start", { kind: "select" });
	await waitFor(() => bubbles().length === 1, "waiting");
	h.fire("agent_settled");
	await settle();
	const count = bubbles().length;
	await sleep(WAITING_MS * 1.5);
	assert.equal(bubbles().length, count);
});

test("a replaced session stops the old heartbeat and posts under the new id", async () => {
	const h = host();
	h.fire("ui_prompt_start", { kind: "confirm" });
	await waitFor(() => bubbles().length === 1, "waiting");
	const old = h.id;
	h.swap("session-replaced");
	h.fire("session_start", { reason: "new" });
	h.tool("bash", { command: "echo hi" });
	await settle();
	const count = bubbles().length;
	await sleep(WAITING_MS * 1.5);
	assert.equal(bubbles().length, count, "the old session's heartbeat must stop");
	assert.equal(lastBubble().session_id, "session-replaced");
	assert.ok(bubbles().filter((b) => b.session_id === old).length === 1);
});

test("the first prompt becomes the card title, and later ones do not churn it", async () => {
	const h = host();
	h.fire("input", { text: "Review the auth refactor" });
	h.fire("input", { text: "now the tests" });
	h.tool("bash", { command: "x" });
	await settle();
	assert.equal(lastBubble().title, "Review the auth refactor");
	assert.equal(lastBubble().title_source, "prompt");
});

test("a resumed session recovers its title from the entries", async () => {
	const h = host({ entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "Ship the notes" }] } }] });
	h.fire("session_start", { reason: "resume" });
	h.tool("bash", { command: "x" });
	await settle();
	assert.equal(lastBubble().title, "Ship the notes");
});

test("control characters never reach the bubble", async () => {
	const h = host();
	h.tool("bash", { command: "echo \x1b]0;pwned\x07\nrm -rf x" });
	await waitFor(() => bubbles().length === 1, "one bubble");
	assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(lastBubble().text), JSON.stringify(lastBubble().text));
});

test("a long path keeps its tail", async () => {
	const h = host();
	h.tool("edit", { path: "/elsewhere/a/very/deeply/nested/directory/structure/component.tsx" });
	await waitFor(() => bubbles().length === 1, "one bubble");
	assert.equal(lastBubble().text, "Editing …/component.tsx");
});

test("the killswitch silences everything", async () => {
	writeFileSync(join(RUNTIME, "hooks-disabled"), "");
	try {
		const h = host();
		h.fire("input", { text: "go" });
		h.fire("agent_settled");
		await settle();
		assert.equal(requests.length, 0);
	} finally {
		unlinkSync(join(RUNTIME, "hooks-disabled"));
	}
});

test("no token (app not running) posts nothing and does not throw", async () => {
	unlinkSync(join(RUNTIME, "update-token"));
	try {
		const h = host();
		h.fire("agent_settled");
		await settle();
		assert.equal(requests.length, 0);
	} finally {
		writeFileSync(join(RUNTIME, "update-token"), `${TOKEN}\n`);
	}
});

test("RPC and print modes are left alone", async () => {
	for (const mode of ["rpc", "print"]) {
		const h = host({ mode });
		h.fire("input", { text: "go" });
		h.tool("bash", { command: "x" });
		h.fire("agent_settled");
	}
	await settle();
	assert.equal(requests.length, 0);
});

test("PI_PETDEX=off registers nothing", async () => {
	process.env.PI_PETDEX = "off";
	try {
		const h = host();
		assert.equal(h.handlers.size, 0);
		assert.equal(h.commands.size, 0);
	} finally {
		delete process.env.PI_PETDEX;
	}
});

test("/petdex reports connected, disabled and offline", async () => {
	const h = host();
	const run = () => h.commands.get("petdex").handler("", h.ctx);
	await run();
	assert.equal(h.notices.at(-1).message, "Petdex is connected.");
	writeFileSync(join(RUNTIME, "hooks-disabled"), "");
	await run();
	assert.match(h.notices.at(-1).message, /disabled/);
	unlinkSync(join(RUNTIME, "hooks-disabled"));
	unlinkSync(join(RUNTIME, "update-token"));
	await run();
	assert.match(h.notices.at(-1).message, /not running/);
	writeFileSync(join(RUNTIME, "update-token"), `${TOKEN}\n`);
});

// ----------------------------------------------------------------- run ----

writeFileSync(join(RUNTIME, "update-token"), `${TOKEN}\n`);

let failed = 0;
for (const [name, fn] of tests) {
	requests.length = 0;
	try {
		await fn();
		// Drain stragglers so one test's late posts never land in the next.
		await settle();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${name}\n       ${String(error.message).split("\n").join("\n       ")}`);
	}
	for (const fire of hosts.splice(0)) fire("session_shutdown");
	await settle();
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
