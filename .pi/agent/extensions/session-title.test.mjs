#!/usr/bin/env node
/**
 * Offline tests for session-title.ts. No pi host, no herdr, no network:
 *
 *   node .pi/agent/extensions/session-title.test.mjs
 *
 * Same shape as todo-md.test.mjs — the extension is loaded through pi's own jiti
 * from a sandbox whose `node_modules` symlinks pi's own packages, so the real
 * `truncateToWidth` is exercised rather than a stand-in. The host surface
 * (`pi.on`, `pi.exec`, the session manager, `ui.setTitle`) is faked here, which
 * is what makes the emitted title and the `rex` calls assertable — no test ever
 * reaches a real Rex server, even when run from inside a Rex pane.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ------------------------------------------------------------- sandbox ----

/**
 * pi's package dir, found through the `pi` on PATH rather than a hardcoded prefix.
 * A managed install puts a shell wrapper there (`~/.pi/agent/bin/pi`) that execs
 * `install/releases/<current-version>/node_modules/.bin/pi`, so follow it.
 */
function findPiDir() {
	let bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
	const current = join(dirname(dirname(bin)), "install", "current-version");
	if (existsSync(current)) {
		const version = readFileSync(current, "utf8").trim();
		bin = realpathSync(join(dirname(current), "releases", version, "node_modules", ".bin", "pi"));
	}
	const dir = dirname(dirname(dirname(bin))); // dist/bundle/cli.js -> package root
	assert.ok(existsSync(join(dir, "package.json")), `pi package not found at ${dir}`);
	return dir;
}

const PI_DIR = findPiDir();
/** A dependency of pi's, nested under its package or hoisted beside it. */
const dep = (name) =>
	[join(PI_DIR, "node_modules", name), join(dirname(dirname(PI_DIR)), name)].find((p) => existsSync(p)) ??
	assert.fail(`${name} not found beside pi at ${PI_DIR}`);
const SANDBOX = mkdtempSync(join(tmpdir(), "session-title-test-"));

mkdirSync(join(SANDBOX, "node_modules", "@earendil-works"), { recursive: true });
symlinkSync(dep("@earendil-works/pi-tui"), join(SANDBOX, "node_modules", "@earendil-works", "pi-tui"));
symlinkSync(PI_DIR, join(SANDBOX, "node_modules", "@earendil-works", "pi-coding-agent"));

// Loaded the way pi loads it: through pi's own jiti. Copied into the sandbox so
// its imports resolve against the sandbox `node_modules`.
const BUILT = join(SANDBOX, "session-title.ts");
writeFileSync(BUILT, readFileSync(join(import.meta.dirname, "session-title.ts")));

// The delay is read at module load, so it must be set before the import. The
// gate (HERDR_ENV / REX_*) is read per instance, which host() relies on.
process.env.PI_SESSION_TITLE_DELAY_MS = "5";
const { createJiti } = await import(join(dep("jiti"), "lib", "jiti.mjs"));
const extension = await createJiti(import.meta.url, { fsCache: false, moduleCache: false }).import(BUILT, {
	default: true,
});

const REASSERT_MS = 25;
const settle = () => new Promise((resolve) => setTimeout(resolve, REASSERT_MS));

// ---------------------------------------------------------------- fakes ----

const userEntry = (text) => ({ type: "message", message: { role: "user", content: text } });

/** One extension instance plus the host surface it talks to. */
function host({ sessionName = undefined, entries = [], mode = "tui", hasUI = true, rex = false, rexLabel = "shell" } = {}) {
	const state = { handlers: new Map(), titles: [], rex: [] };

	// Default to herdr only, whatever pane this test happens to run in.
	process.env.HERDR_ENV = rex ? "" : "1";
	if (rex) {
		process.env.REX_SESSION = "session:test";
		process.env.REX_BLOCK = "block:test";
	} else {
		delete process.env.REX_SESSION;
		delete process.env.REX_BLOCK;
	}

	extension({
		on: (event, handler) => state.handlers.set(event, handler),
		exec: async (command, args) => {
			state.rex.push([command, ...args]);
			if (args[0] === "block" && args[1] === "inspect") {
				return { stdout: JSON.stringify({ block: { label: rexLabel } }), stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const ctx = {
		mode,
		hasUI,
		cwd: "/tmp/project",
		sessionManager: {
			getSessionName: () => sessionName,
			getEntries: () => entries,
		},
		ui: { setTitle: (title) => state.titles.push(title) },
	};

	const fire = async (event, payload = {}) => {
		const handler = state.handlers.get(event);
		if (handler) {
			await handler(payload, ctx);
		}
	};

	return {
		state,
		ctx,
		fire,
		title: () => state.titles[state.titles.length - 1],
		/** The labels passed to `rex block rename`, in order. */
		renames: () => state.rex.filter((c) => c[2] === "rename").map((c) => c[c.length - 1]),
		prompt: (text) => fire("message_start", { message: { role: "user", content: text } }),
		setName: (name) => {
			sessionName = name;
		},
	};
}

// ---------------------------------------------------------------- tests ----

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the first user prompt becomes the title", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	assert.equal(h.title(), "Review the auth refactor");
});

test("later prompts do not churn the title", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.prompt("now also check the tests");
	assert.equal(h.title(), "Review the auth refactor");
	assert.equal(h.state.titles.length, 1, "one title write, not one per turn");
});

test("PI_SESSION_TITLE=last tracks the most recent prompt", async () => {
	process.env.PI_SESSION_TITLE = "last";
	try {
		const h = host();
		await h.fire("session_start", { reason: "startup" });
		await h.prompt("Review the auth refactor");
		await h.prompt("now also check the tests");
		assert.equal(h.title(), "now also check the tests");
	} finally {
		delete process.env.PI_SESSION_TITLE;
	}
});

test("assistant and tool messages are ignored", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.fire("message_start", { message: { role: "assistant", content: [{ type: "text", text: "sure thing" }] } });
	await h.fire("message_start", { message: { role: "toolResult", content: [{ type: "text", text: "output" }] } });
	assert.equal(h.title(), undefined, "only user messages set the title");
});

test("an explicit session name defers to pi entirely", async () => {
	const h = host({ sessionName: "auth-refactor" });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await settle();
	assert.equal(h.state.titles.length, 0, "pi already renders the name; do not fight it");
});

test("resume recovers the label from session entries", async () => {
	const h = host({ entries: [userEntry("Ship the release notes"), userEntry("and bump the version")] });
	await h.fire("session_start", { reason: "resume" });
	await settle();
	assert.equal(h.title(), "Ship the release notes");
});

test("the re-assert is delayed past pi's own updateTerminalTitle", async () => {
	const h = host({ entries: [userEntry("Ship the release notes")] });
	await h.fire("session_start", { reason: "resume" });
	assert.equal(h.state.titles.length, 0, "must not write during bind, pi would clobber it");
	await settle();
	assert.equal(h.state.titles.length, 1);
});

test("a replaced session drops the previous task", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.fire("session_start", { reason: "new" });
	await h.prompt("Something else entirely");
	assert.equal(h.title(), "Something else entirely");
});

test("control characters are stripped so the OSC cannot be terminated early", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("fix \x07 the \x1b]0;pwned\x07 parser");
	const title = h.title();
	assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(title), `control char survived: ${JSON.stringify(title)}`);
	assert.equal(title, "fix the ]0;pwned parser");
});

test("newlines and runs of whitespace collapse to one line", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("  Review   the\n\n\tauth refactor  ");
	assert.equal(h.title(), "Review the auth refactor");
});

test("long prompts are truncated to the sidebar's budget", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Refactor the authentication middleware so that every request revalidates its session token");
	const title = h.title();
	assert.ok(title.length <= 44, `too wide: ${title.length}`);
	assert.ok(title.endsWith("…"), `expected an ellipsis: ${JSON.stringify(title)}`);
	// truncateToWidth pads its ellipsis with ANSI resets; they must not survive.
	assert.ok(!title.includes("\u001b"), `escape sequence in title: ${JSON.stringify(title)}`);
});

test("text parts are used and images contribute nothing", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt([
		{ type: "image", data: "…", mimeType: "image/png" },
		{ type: "text", text: "what is wrong with this screenshot" },
	]);
	assert.equal(h.title(), "what is wrong with this screenshot");
});

test("an image-only prompt leaves the title alone", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt([{ type: "image", data: "…", mimeType: "image/png" }]);
	assert.equal(h.title(), undefined);
});

test("naming a session mid-run hands the title back to pi", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	h.setName("auth-refactor");
	await h.fire("session_info_changed", { name: "auth-refactor" });
	await settle();
	assert.equal(h.state.titles.length, 1, "no further writes once pi owns the title");
});

test("clearing the name re-asserts our label", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.fire("session_info_changed", { name: undefined });
	await settle();
	assert.equal(h.state.titles.length, 2);
	assert.equal(h.title(), "Review the auth refactor");
});

test("a headless session is left alone", async () => {
	const h = host({ mode: "print", hasUI: false });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await settle();
	assert.equal(h.state.titles.length, 0);
});

// pi documents hasUI as true in RPC mode too, so gating on it would marshal the
// title into an extension_ui_request JSON line on the protocol stream. Gate on
// mode instead — the same correction herdr's own integration made in v8.
test("RPC mode is left alone even though it reports hasUI", async () => {
	const h = host({ mode: "rpc", hasUI: true });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await settle();
	assert.equal(h.state.titles.length, 0, "a terminal title has no meaning over RPC");
});

test("outside herdr and Rex the extension does nothing", async () => {
	process.env.HERDR_ENV = "";
	const state = { handlers: new Map() };
	delete process.env.REX_SESSION;
	delete process.env.REX_BLOCK;
	extension({ on: (event, handler) => state.handlers.set(event, handler) });
	assert.equal(state.handlers.size, 0, "no handlers outside a multiplexer");
});

test("in Rex the first prompt renames the pane as well as the title", async () => {
	const h = host({ rex: true });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.prompt("and the tests");
	await settle();
	assert.equal(h.title(), "Review the auth refactor");
	assert.deepEqual(h.renames(), ["Review the auth refactor"], "one rename, not one per turn");
	assert.deepEqual(h.state.rex.at(-1), ["rex", "block", "rename", "-s", "session:test", "block:test", "Review the auth refactor"]);
});

test("the original pane label is read before the first rename overwrites it", async () => {
	const h = host({ rex: true });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await settle();
	assert.equal(h.state.rex[0][2], "inspect");
	assert.equal(h.state.rex[1][2], "rename");
});

test("quitting pi puts the original pane label back", async () => {
	const h = host({ rex: true, rexLabel: "logs" });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(h.renames(), ["Review the auth refactor", "logs"]);
});

test("a pane pi never renamed is left alone at shutdown", async () => {
	const h = host({ rex: true });
	await h.fire("session_start", { reason: "startup" });
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.state.rex.length, 0);
});

test("an explicit session name goes on the Rex pane", async () => {
	const h = host({ rex: true, sessionName: "auth-refactor" });
	await h.fire("session_start", { reason: "startup" });
	await settle();
	assert.equal(h.state.titles.length, 0, "pi still owns the title");
	assert.deepEqual(h.renames(), ["auth-refactor"]);
});

test("naming a session mid-run renames the Rex pane to the name", async () => {
	const h = host({ rex: true });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	h.setName("auth-refactor");
	await h.fire("session_info_changed", { name: "auth-refactor" });
	await settle();
	assert.deepEqual(h.renames(), ["Review the auth refactor", "auth-refactor"]);
});

test("a herdr pane never calls rex", async () => {
	const h = host();
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.state.rex.length, 0);
});

test("RPC mode in a Rex pane renames nothing", async () => {
	const h = host({ rex: true, mode: "rpc" });
	await h.fire("session_start", { reason: "startup" });
	await h.prompt("Review the auth refactor");
	await settle();
	assert.equal(h.state.rex.length, 0);
});

// ----------------------------------------------------------------- run ----

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${name}\n       ${String(error.message).split("\n").join("\n       ")}`);
	}
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
