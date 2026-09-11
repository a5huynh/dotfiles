#!/usr/bin/env node
/**
 * Offline tests for todo-md.ts. No pi host, no network, no model:
 *
 *   node .pi/agent/extensions/todo-md.test.mjs
 *
 * The extension is transpiled with the esbuild that ships inside pi and imported
 * into a sandbox whose `node_modules` symlinks pi's own packages, so the real
 * `getAgentDir` / `truncateToWidth` / typebox are exercised. Everything the host
 * would provide — `pi.exec`, the session manager, the TUI, the theme — is faked
 * here, which is what makes the widget's own output assertable.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ------------------------------------------------------------- sandbox ----

/** pi's package dir, found through the `pi` on PATH rather than a hardcoded prefix. */
function findPiDir() {
	const bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
	const dir = dirname(dirname(dirname(bin))); // dist/bundle/cli.js -> package root
	assert.ok(existsSync(join(dir, "package.json")), `pi package not found at ${dir}`);
	return dir;
}

const PI_DIR = findPiDir();
const SANDBOX = mkdtempSync(join(tmpdir(), "todo-md-test-"));
const AGENT_DIR = join(SANDBOX, "agent");
const PROJECT = join(SANDBOX, "project");

mkdirSync(join(SANDBOX, "node_modules", "@earendil-works"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
for (const pkg of ["pi-ai", "pi-tui"]) {
	symlinkSync(join(PI_DIR, "node_modules", "@earendil-works", pkg), join(SANDBOX, "node_modules", "@earendil-works", pkg));
}
symlinkSync(PI_DIR, join(SANDBOX, "node_modules", "@earendil-works", "pi-coding-agent"));
symlinkSync(join(PI_DIR, "node_modules", "typebox"), join(SANDBOX, "node_modules", "typebox"));

const SOURCE = join(import.meta.dirname, "todo-md.ts");
const BUILT = join(SANDBOX, "todo-md.mjs");
execFileSync(join(PI_DIR, "node_modules", ".bin", "esbuild"), [
	SOURCE,
	"--format=esm",
	"--platform=node",
	"--target=node22",
	`--outfile=${BUILT}`,
	"--log-level=error",
]);

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const { default: extension } = await import(BUILT);

// ---------------------------------------------------------------- fakes ----

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (t) => t,
	italic: (t) => t,
	underline: (t) => t,
	inverse: (t) => t,
	// Marked rather than styled, so a test can assert a row was struck through.
	strikethrough: (t) => `~${t}~`,
};

const tui = { requestRender() {}, terminal: { columns: 80 } };

/** One extension instance plus the host surface it talks to. */
function host({ cwd = PROJECT, sessionId = "sess-1", mode = "tui" } = {}) {
	const state = { widget: undefined, overlay: undefined, notices: [], handlers: new Map(), tools: new Map(), commands: new Map() };
	let mounted;

	const api = {
		exec: async () => ({ stdout: `${cwd}\n`, stderr: "", code: 0 }),
		on: (event, handler) => state.handlers.set(event, handler),
		registerTool: (tool) => state.tools.set(tool.name, tool),
		registerCommand: (name, command) => state.commands.set(name, command),
	};
	extension(api);

	const ctx = {
		cwd,
		hasUI: true,
		mode,
		sessionManager: {
			getSessionFile: () => (sessionId ? join(SANDBOX, `${sessionId}.jsonl`) : undefined),
			getSessionId: () => sessionId,
		},
		ui: {
			notify: (message) => state.notices.push(message),
			setWidget: (_key, factory) => {
				// The host disposes the outgoing widget; so must we, or the spinner
				// interval keeps the test process alive.
				mounted?.dispose?.();
				mounted = factory ? factory(tui, theme) : undefined;
				state.widget = mounted ? mounted.render(80) : undefined;
			},
			custom: async (factory) => {
				const component = factory(tui, theme, {}, () => {});
				state.overlay = component.render(80);
			},
		},
	};

	return {
		state,
		ctx,
		todo: (params) => state.tools.get("todo").execute("call-1", params, undefined, () => {}, ctx),
		command: (args) => state.commands.get("todos").handler(args, ctx),
		unmount: () => mounted?.dispose?.(),
	};
}

const sessionFile = (root, id) =>
	join(AGENT_DIR, "todos", `--${root.replace(/^\//, "").replaceAll("/", "-")}--`, `todo-${id}.md`);

const read = (path) => readFileSync(path, "utf8");
const lines = (widget) => (widget ?? []).join("\n");
const re = (literal) => new RegExp(literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));

// ---------------------------------------------------------------- tests ----

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fresh() {
	rmSync(join(AGENT_DIR, "todos"), { recursive: true, force: true });
	rmSync(join(PROJECT, ".pi"), { recursive: true, force: true });
	rmSync(join(PROJECT, "todo.md"), { force: true });
	delete process.env.PI_TODOS;
}

const config = (values) => {
	mkdirSync(join(PROJECT, ".pi"), { recursive: true });
	writeFileSync(join(PROJECT, ".pi", "todo-md-config.json"), JSON.stringify(values));
};

test("session scope writes under the agent dir, never the repo", async () => {
	const h = host();
	const result = await h.todo({ action: "add", text: "wire the widget\nship the docs" });

	const path = sessionFile(PROJECT, "sess-1");
	assert.ok(existsSync(path), `expected ${path}`);
	assert.equal(read(path), "# Todo\n\n- [ ] wire the widget\n- [ ] ship the docs\n");
	assert.ok(!existsSync(join(PROJECT, "todo.md")), "repo must stay clean");
	assert.match(result.content[0].text, /2 todos \(2 open\)/);
	assert.equal(result.details.scope, "session");
	h.unmount();
});

test("widget renders header, ids and status glyphs", async () => {
	const h = host();
	await h.todo({ action: "add", text: "one\ntwo\nthree" });
	await h.todo({ action: "start", id: 2 });
	await h.todo({ action: "toggle", id: 1 });

	const out = lines(h.state.widget);
	assert.match(out, /● 3 todos \(1 done, 1 in progress, 1 open\)/);
	// Completed rows are struck through; in-progress rows carry a spinner frame,
	// a trailing ellipsis and an elapsed clock; pending rows are plain.
	assert.match(out, /✔ ~#1 one~/);
	assert.match(out, /[✳✴✵✶✷✸✹✺✻✼✽] #2 two… \(\d+s\)/);
	assert.match(out, /◻ #3 three/);
	h.unmount();
});

test("markdown carries the three states, and `[-]`/`[~]` read as in progress", async () => {
	const h = host();
	await h.todo({ action: "add", text: "a\nb\nc" });
	await h.todo({ action: "start", id: 1 });
	await h.todo({ action: "toggle", id: 2 });
	assert.match(read(sessionFile(PROJECT, "sess-1")), /- \[\/\] a\n- \[x\] b\n- \[ \] c/);

	writeFileSync(sessionFile(PROJECT, "sess-1"), "- [-] dash\n- [~] tilde\n- [X] upper\n");
	const listed = await h.todo({ action: "list" });
	assert.deepEqual(
		listed.details.todos.map((t) => t.status),
		["in_progress", "in_progress", "completed"],
	);
	h.unmount();
});

test("toggle sends a completed item back to pending", async () => {
	const h = host();
	await h.todo({ action: "add", text: "flip me" });
	await h.todo({ action: "toggle", id: 1 });
	const back = await h.todo({ action: "toggle", id: 1 });
	assert.equal(back.details.todos[0].status, "pending");
	h.unmount();
});

test("widget hides itself when everything is done, and shows it when told not to", async () => {
	const h = host();
	await h.todo({ action: "add", text: "only one" });
	await h.todo({ action: "toggle", id: 1 });
	assert.equal(h.state.widget, undefined);
	h.unmount();

	config({ hideWhenComplete: false });
	const shown = host();
	await shown.todo({ action: "list" });
	assert.match(lines(shown.state.widget), /1 todo \(1 done\)/);
	shown.unmount();
});

test("maxVisible overflows, collapseCompleted folds, sortOrder reorders", async () => {
	config({ maxVisible: 2, collapseCompleted: true, sortOrder: "active" });
	const h = host();
	await h.todo({ action: "add", text: "one\ntwo\nthree\nfour" });
	await h.todo({ action: "toggle", id: 1 });
	await h.todo({ action: "start", id: 3 });

	const out = lines(h.state.widget);
	// active order: in-progress first, then pending by id; the completed row is
	// folded into a summary and so never counts against maxVisible.
	assert.match(out, /#3 three…/);
	assert.match(out, /#2 two/);
	assert.doesNotMatch(out, /#4 four/);
	assert.match(out, /… and 1 more/);
	assert.match(out, /✔ 1 completed/);
	h.unmount();
});

test("hiddenAt: top puts the overflow above the rows it hid", async () => {
	config({ maxVisible: 1, hiddenAt: "top" });
	const h = host();
	await h.todo({ action: "add", text: "one\ntwo\nthree" });

	const out = h.state.widget;
	assert.match(out[1], /… and 2 more/);
	assert.match(out[2], /#3 three/);
	h.unmount();
});

test("a malformed config cannot break the widget", async () => {
	config({ maxVisible: "banana", sortOrder: "sideways", hiddenAt: 7, glyphs: { pending: "\u0007", completed: "☑" } });
	const h = host();
	await h.todo({ action: "add", text: "one\ntwo" });
	await h.todo({ action: "toggle", id: 1 });

	const out = lines(h.state.widget);
	assert.match(out, /☑ ~#1 one~/); // a safe glyph is honoured
	assert.match(out, /◻ #2 two/); // a control character is not
	h.unmount();
});

test("non-todo lines round-trip verbatim and new items land after the last checkbox", async () => {
	const h = host();
	const path = sessionFile(PROJECT, "sess-1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "# Notes\n\nSome prose.\n\n- [ ] first\n\n## Later\n\nMore prose.\n");

	await h.todo({ action: "add", text: "second" });
	assert.equal(read(path), "# Notes\n\nSome prose.\n\n- [ ] first\n- [ ] second\n\n## Later\n\nMore prose.\n");
	h.unmount();
});

test("add strips markdown the model pastes in", async () => {
	const h = host();
	const result = await h.todo({ action: "add", text: "- [ ] bulleted\n* starred\n  - [x] indented" });
	assert.deepEqual(
		result.details.todos.map((t) => t.text),
		["bulleted", "starred", "indented"],
	);
	h.unmount();
});

test("clear_done removes finished items and an emptied session file deletes itself", async () => {
	const h = host();
	const path = sessionFile(PROJECT, "sess-1");
	await h.todo({ action: "add", text: "keep\ndrop" });
	await h.todo({ action: "toggle", id: 2 });
	await h.todo({ action: "clear_done" });
	assert.match(read(path), /- \[ \] keep/);
	assert.doesNotMatch(read(path), /drop/);

	await h.todo({ action: "remove", id: 1 });
	assert.ok(!existsSync(path), "empty session list should not linger under the agent dir");
	assert.ok(!existsSync(dirname(path)), "its project bucket should be reclaimed too");
	h.unmount();
});

test("bad arguments fail without touching the file", async () => {
	const h = host();
	await h.todo({ action: "add", text: "one" });
	const before = read(sessionFile(PROJECT, "sess-1"));

	for (const params of [
		{ action: "add", text: "   " },
		{ action: "toggle" },
		{ action: "remove", id: 99 },
		{ action: "clear_done" },
	]) {
		const result = await h.todo(params);
		assert.equal(result.isError, true, `${params.action} should have failed`);
	}
	assert.equal(read(sessionFile(PROJECT, "sess-1")), before);
	h.unmount();
});

test("project scope writes the repo's own todo.md", async () => {
	config({ scope: "project" });
	const h = host();
	const result = await h.todo({ action: "add", text: "committable" });
	assert.equal(read(join(PROJECT, "todo.md")), "# Todo\n\n- [ ] committable\n");
	assert.equal(result.details.scope, "project");
	assert.match(lines(h.state.widget), /· todo\.md/); // header names a non-session list
	h.unmount();
});

test("PI_TODOS=off keeps the list in memory", async () => {
	process.env.PI_TODOS = "off";
	const h = host();
	const result = await h.todo({ action: "add", text: "ephemeral" });
	assert.equal(result.details.scope, "memory");
	assert.equal(result.details.todos[0].text, "ephemeral");
	assert.ok(!existsSync(join(AGENT_DIR, "todos")), "memory scope must write nothing");

	const same = await h.todo({ action: "list" });
	assert.equal(same.details.todos.length, 1, "memory list should survive within the process");
	h.unmount();
});

test("PI_TODOS=<name> shares one list, PI_TODOS=<path> points at a file", async () => {
	process.env.PI_TODOS = "sprint-1";
	const named = host();
	await named.todo({ action: "add", text: "shared" });
	assert.equal(read(join(AGENT_DIR, "todos", "shared", "sprint-1.md")), "# Todo\n\n- [ ] shared\n");
	named.unmount();

	process.env.PI_TODOS = "./plans/todo.md";
	const explicit = host();
	const result = await explicit.todo({ action: "add", text: "explicit" });
	assert.equal(read(join(PROJECT, "plans", "todo.md")), "# Todo\n\n- [ ] explicit\n");
	assert.equal(result.details.scope, "explicit");
	explicit.unmount();
});

test("two agents adding to one shared list lose nothing", async () => {
	process.env.PI_TODOS = "team";
	const agents = [host({ sessionId: "a" }), host({ sessionId: "b" }), host({ sessionId: "c" })];
	await Promise.all(agents.flatMap((a, i) => [a.todo({ action: "add", text: `a${i}-1` }), a.todo({ action: "add", text: `a${i}-2` })]));

	const body = read(join(AGENT_DIR, "todos", "shared", "team.md"));
	for (let i = 0; i < agents.length; i++) {
		assert.match(body, new RegExp(`- \\[ \\] a${i}-1`));
		assert.match(body, new RegExp(`- \\[ \\] a${i}-2`));
	}
	assert.equal(body.match(/- \[ \]/g).length, 6);
	for (const agent of agents) agent.unmount();
});

// `null`, not `undefined` — a destructuring default would fill `undefined` back in.
test("a session pi is not persisting falls back to memory", async () => {
	const h = host({ sessionId: null });
	const result = await h.todo({ action: "add", text: "no session" });
	assert.equal(result.details.scope, "memory");
	assert.ok(!existsSync(join(AGENT_DIR, "todos")));
	h.unmount();
});

test("/todos renders the full list, /todos sessions lists the project's lists", async () => {
	const mine = host({ sessionId: "sess-1" });
	await mine.todo({ action: "add", text: "mine\nalso mine" });
	await mine.todo({ action: "toggle", id: 1 });
	const other = host({ sessionId: "sess-2" });
	await other.todo({ action: "add", text: "theirs" });

	await mine.command("");
	const overlay = lines(mine.state.overlay);
	assert.match(overlay, /todos/);
	assert.match(overlay, /2 todos \(1 done, 1 open\)/);
	assert.match(overlay, /✔ #1 {3}~mine~/);
	assert.match(overlay, /escape to close/);
	assert.match(overlay, re(join(AGENT_DIR, "todos").slice(0, 40)));

	await mine.command("sessions");
	const sessions = lines(mine.state.overlay);
	assert.match(sessions, /sess-1.*1\/2 done.*this session/s);
	assert.match(sessions, /sess-2.*0\/1 done/);
	mine.unmount();
	other.unmount();
});

test("/todos hide and show toggle the widget", async () => {
	const h = host();
	await h.todo({ action: "add", text: "visible" });
	assert.ok(h.state.widget);

	await h.command("hide");
	assert.equal(h.state.widget, undefined);
	await h.command("show");
	assert.match(lines(h.state.widget), /visible/);
	h.unmount();
});

test("agent_end picks up edits made outside the tool", async () => {
	const h = host();
	await h.todo({ action: "add", text: "from the tool" });
	writeFileSync(sessionFile(PROJECT, "sess-1"), "- [ ] from the tool\n- [/] edited by hand\n");

	await h.state.handlers.get("agent_end")({}, h.ctx);
	assert.match(lines(h.state.widget), /edited by hand…/);
	h.unmount();
});

// ----------------------------------------------------------------- run ----

let failed = 0;
for (const [name, fn] of tests) {
	fresh();
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
