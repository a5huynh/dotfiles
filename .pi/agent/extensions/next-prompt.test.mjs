#!/usr/bin/env node
/**
 * Offline tests for next-prompt.ts and its ghost-text half in
 * border-status-editor.ts. No pi host, no network, no model:
 *
 *   node .pi/agent/extensions/next-prompt.test.mjs
 *
 * Same shape as session-title.test.mjs — both extensions are transpiled with
 * the esbuild inside pi and imported into a sandbox whose `node_modules`
 * symlinks pi's own packages. `modelRegistry.complete` is faked, so the
 * generator's gating and filtering are assertable; the editor is pi's real
 * `CustomEditor`, so the rendered ghost line and Tab/→ accept are too.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
const SANDBOX = mkdtempSync(join(tmpdir(), "next-prompt-test-"));

mkdirSync(join(SANDBOX, "node_modules", "@earendil-works"), { recursive: true });
for (const pkg of ["pi-tui", "pi-ai", "pi-agent-core"]) {
	symlinkSync(join(PI_DIR, "node_modules", "@earendil-works", pkg), join(SANDBOX, "node_modules", "@earendil-works", pkg));
}
symlinkSync(PI_DIR, join(SANDBOX, "node_modules", "@earendil-works", "pi-coding-agent"));

function build(name) {
	const out = join(SANDBOX, `${name}.mjs`);
	execFileSync(join(PI_DIR, "node_modules", ".bin", "esbuild"), [
		join(import.meta.dirname, `${name}.ts`),
		"--format=esm",
		"--platform=node",
		"--target=node22",
		"--packages=external",
		`--outfile=${out}`,
		"--log-level=error",
	]);
	return out;
}

const nextPrompt = await import(build("next-prompt"));
const borderStatus = await import(build("border-status-editor"));
const { default: extension, cleanSuggestion, buildTranscript, shouldSuggest, resolveModel, SUGGESTION_CHANNEL } = nextPrompt;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------- fakes ----

const user = (text) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text, stopReason = "stop") => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

const SONNET = {
	id: "claude-sonnet-5-5",
	provider: "anthropic",
	api: "anthropic-messages",
	thinkingLevelMap: { off: null, minimal: null, low: "low" },
	compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
};

function registry({ known = [SONNET], auth = true, reply = "run the tests", stopReason = "stop", hold } = {}) {
	const calls = [];
	return {
		calls,
		find: (provider, id) => known.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => auth,
		complete: async (model, context, options) => {
			calls.push({ model, context, options });
			if (hold) await hold(options.signal);
			if (options.signal?.aborted) return { stopReason: "aborted", content: [] };
			return { stopReason, content: [{ type: "text", text: reply }] };
		},
	};
}

function eventBus() {
	const handlers = new Map();
	return {
		emit: (channel, data) => (handlers.get(channel) ?? []).forEach((h) => h(data)),
		on: (channel, handler) => {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => {};
		},
	};
}

/** One next-prompt instance wired to a fake host. */
function host({ entries = [user("fix the bug and run tests"), assistant("Fixed the off-by-one.")], mode = "tui", idle = true, editor = "", reg = registry() } = {}) {
	const handlers = new Map();
	const events = eventBus();
	const published = [];
	events.on(SUGGESTION_CHANNEL, (data) => published.push(data.text));
	extension({ on: (event, handler) => handlers.set(event, handler), events });

	const state = { editor, idle };
	const ctx = {
		mode,
		isIdle: () => state.idle,
		ui: { getEditorText: () => state.editor },
		sessionManager: { getBranch: () => entries },
		modelRegistry: reg,
	};
	const fire = async (event, payload = {}) => handlers.get(event)?.(payload, ctx);
	return { state, ctx, fire, reg, published, last: () => published[published.length - 1] };
}

// ---------------------------------------------------------------- tests ----

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a settled turn publishes the cleaned suggestion", async () => {
	const h = host({ reg: registry({ reply: '"run the tests"' }) });
	await h.fire("agent_settled");
	assert.equal(h.last(), "run the tests");
});

test("Haiku 5.5 is synthesized from Sonnet with thinking disabled and no forced effort", async () => {
	const h = host();
	await h.fire("agent_settled");
	const { model, options } = h.reg.calls[0];
	assert.equal(model.id, "claude-haiku-5-5");
	assert.equal(model.provider, "anthropic");
	assert.notEqual(model.thinkingLevelMap?.off, null, "off:null suppresses thinking:{type:disabled}");
	assert.notEqual(model.compat.supportsMidConvoEffort, true, "would force adaptive thinking at effort high");
	assert.equal(options.thinkingEnabled, false);
	assert.ok(options.maxTokens <= 200);
	assert.equal(options.temperature, undefined, "Haiku 5.5 rejects sampling params");
});

test("the registry's own Haiku 5.5 wins once pi ships it", async () => {
	const native = { id: "claude-haiku-5-5", provider: "anthropic", native: true };
	assert.equal(resolveModel(registry({ known: [SONNET, native] })), native);
});

test("PI_NEXT_PROMPT_MODEL picks another registered model and never synthesizes one", () => {
	const other = { id: "claude-haiku-4-5", provider: "anthropic" };
	assert.equal(resolveModel(registry({ known: [SONNET, other] }), "anthropic/claude-haiku-4-5"), other);
	assert.equal(resolveModel(registry(), "anthropic/claude-nope"), undefined);
	assert.equal(resolveModel(registry(), "garbage"), undefined);
});

test("the request ends on a user turn (Haiku 5.5 rejects prefill)", async () => {
	const h = host();
	await h.fire("agent_settled");
	const { messages, systemPrompt } = h.reg.calls[0].context;
	assert.equal(messages.at(-1).role, "user");
	assert.match(systemPrompt, /SUGGESTION MODE/);
	assert.match(messages[0].content[0].text, /User: fix the bug and run tests/);
});

test("nothing is requested without auth, outside the TUI, or with PI_NEXT_PROMPT=off", async () => {
	for (const h of [host({ reg: registry({ auth: false }) }), host({ mode: "rpc" }), host({ mode: "print" })]) {
		await h.fire("agent_settled");
		assert.equal(h.reg.calls.length, 0);
	}
	process.env.PI_NEXT_PROMPT = "off";
	try {
		const h = host();
		await h.fire("agent_settled");
		assert.equal(h.reg.calls.length, 0);
	} finally {
		delete process.env.PI_NEXT_PROMPT;
	}
});

test("nothing is requested while the user is already typing", async () => {
	const h = host({ editor: "half a thought" });
	await h.fire("agent_settled");
	assert.equal(h.reg.calls.length, 0);
});

test("silence after an errored or aborted turn", async () => {
	for (const stop of ["error", "aborted"]) {
		const h = host({ entries: [user("do it"), assistant("boom", stop)] });
		await h.fire("agent_settled");
		assert.equal(h.reg.calls.length, 0, stop);
	}
});

test("a refusal (stopReason error) publishes nothing", async () => {
	const h = host({ reg: registry({ stopReason: "error" }) });
	await h.fire("agent_settled");
	assert.deepEqual(h.published, []);
});

test("a submit while the call is in flight aborts it and drops the result", async () => {
	let release;
	const reg = registry({ hold: () => new Promise((resolve) => (release = resolve)) });
	const h = host({ reg });
	const pending = h.fire("agent_settled");
	await tick();
	await h.fire("input", { text: "something else" });
	assert.equal(reg.calls[0].options.signal.aborted, true);
	release();
	await pending;
	assert.deepEqual(h.published, []);
});

test("typing during the call drops the result", async () => {
	let release;
	const reg = registry({ hold: () => new Promise((resolve) => (release = resolve)) });
	const h = host({ reg });
	const pending = h.fire("agent_settled");
	await tick();
	h.state.editor = "already typing";
	release();
	await pending;
	assert.deepEqual(h.published, []);
});

test("a new turn clears a showing suggestion", async () => {
	const h = host();
	await h.fire("agent_settled");
	await h.fire("before_agent_start");
	assert.equal(h.last(), null);
});

test("a throwing registry never escapes the handler", async () => {
	const reg = registry();
	reg.complete = async () => {
		throw new Error("network down");
	};
	const h = host({ reg });
	await h.fire("agent_settled");
	assert.deepEqual(h.published, []);
});

test("cleanSuggestion strips wrappers, labels and quotes", () => {
	assert.equal(cleanSuggestion("<suggestion>commit this</suggestion>"), "commit this");
	assert.equal(cleanSuggestion("Suggestion: push it"), "push it");
	assert.equal(cleanSuggestion("  'go ahead'  "), "go ahead");
});

test("cleanSuggestion rejects meta, questions, evaluations, agent-voice and essays", () => {
	for (const bad of [
		"",
		"Nothing to suggest.",
		"No suggestion",
		"done",
		"I'll stay silent here",
		"what about the tests?",
		"looks good",
		"Thanks!",
		"Let me run the tests",
		"Here's what to do",
		"first line\nsecond line",
		Array(25).fill("word").join(" "),
	]) {
		assert.equal(cleanSuggestion(bad), null, JSON.stringify(bad));
	}
});

test("cleanSuggestion strips escapes and controls before they reach the editor line", () => {
	const out = cleanSuggestion("run \x1b]0;pwned\x07 the \x1b[31mtests\x1b[0m");
	assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
	assert.equal(out, "run the tests");
});

test("transcript keeps the original request once it scrolls out of the window", () => {
	const entries = [user("ORIGINAL ask"), ...Array.from({ length: 20 }, (_, i) => [user(`u${i}`), assistant(`a${i}`)]).flat()];
	const t = buildTranscript(entries);
	assert.match(t, /<original_request>\nUser: ORIGINAL ask/);
	assert.ok(!t.includes("u0\n"), "old turns are dropped");
	assert.match(t, /Assistant: a19/);
});

test("long assistant text keeps its tail, where the offer or question is", () => {
	const t = buildTranscript([user("go"), assistant(`${"x".repeat(5000)} Want me to commit this?`)]);
	assert.match(t, /Want me to commit this\?/);
	assert.ok(t.length < 3000);
});

test("shouldSuggest needs a user message and a finished assistant turn", () => {
	assert.equal(shouldSuggest([]), false);
	assert.equal(shouldSuggest([assistant("hi")]), false);
	assert.equal(shouldSuggest([user("hi")]), false);
	assert.equal(shouldSuggest([user("hi"), assistant("hello")]), true);
});

// --------------------------------------------------- editor ghost text ----

/** Build the real BorderStatusEditor through its setEditorComponent factory. */
function editorHost() {
	const events = eventBus();
	const handlers = new Map();
	borderStatus.default({
		on: (event, handler) => handlers.set(event, handler),
		events,
		exec: async () => ({ stdout: "" }),
		getThinkingLevel: () => "off",
	});
	let factory;
	const ctx = {
		cwd: "/tmp/project",
		model: undefined,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (c, s) => `<${c}>${s}</${c}>` },
			setWorkingVisible() {},
			setFooter() {},
			setEditorComponent: (f) => (factory = f),
		},
	};
	handlers.get("session_start")({}, ctx);
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
	const theme = { borderColor: (s) => s, selectList: {} };
	const keybindings = { matches: () => false };
	const editor = factory(tui, theme, keybindings);
	editor.focused = true;
	const show = (text) => events.emit(SUGGESTION_CHANNEL, { text });
	const body = () => editor.render(60).join("\n");
	return { editor, show, body };
}

test("an empty editor shows the suggestion as dim ghost text", () => {
	const e = editorHost();
	e.show("run the tests");
	assert.match(e.body(), /<dim>run the tests<\/dim>/);
	assert.equal(e.editor.getText(), "", "ghost text is display-only");
});

test("Tab accepts the suggestion into the editor", () => {
	const e = editorHost();
	e.show("run the tests");
	e.editor.handleInput("\t");
	assert.equal(e.editor.getText(), "run the tests");
	assert.ok(!e.body().includes("<dim>run the tests"), "accepted text is real, not ghost");
});

test("→ accepts the suggestion too", () => {
	const e = editorHost();
	e.show("commit this");
	e.editor.handleInput("\x1b[C");
	assert.equal(e.editor.getText(), "commit this");
});

test("typing hides the ghost and Tab is left alone", () => {
	const e = editorHost();
	e.show("run the tests");
	e.editor.handleInput("x");
	assert.equal(e.editor.getText(), "x");
	assert.ok(!e.body().includes("<dim>run the tests"));
	e.editor.handleInput("\t");
	assert.notEqual(e.editor.getText(), "xrun the tests", "Tab must not accept once the user typed");
});

test("a cleared suggestion leaves Tab and → with their normal meaning", () => {
	const e = editorHost();
	e.show("run the tests");
	e.show(null);
	e.editor.handleInput("\x1b[C");
	assert.equal(e.editor.getText(), "");
	assert.ok(!e.body().includes("<dim>run the tests"));
});

test("a long suggestion is truncated to the editor width", () => {
	const e = editorHost();
	e.show(Array(20).fill("verbose").join(" "));
	for (const line of e.editor.render(60)) {
		const visible = line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|<\/?\w+>/g, "");
		assert.ok(visible.length <= 60, `overflow: ${visible.length}`);
	}
});

// ----------------------------------------------------------------- run ----

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${name}\n       ${String(error.stack ?? error.message).split("\n").slice(0, 4).join("\n       ")}`);
	}
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
