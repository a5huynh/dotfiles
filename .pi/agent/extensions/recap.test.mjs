#!/usr/bin/env node
/**
 * Offline tests for recap.ts. No pi host, no network, no model:
 *
 *   node .pi/agent/extensions/recap.test.mjs
 *
 * Same shape as todo-md.test.mjs and session-title.test.mjs — the extension is
 * transpiled with the esbuild that ships inside pi and imported into a sandbox
 * whose `node_modules` symlinks pi's own packages, so the real `Markdown`,
 * `Box` and `DynamicBorder` are exercised and the card's own rendered lines are
 * assertable. Two things are faked rather than symlinked:
 *
 *   - `@earendil-works/pi-ai` is replaced by a stub package, so `complete()`
 *     returns a canned summary instead of calling a provider. That also makes
 *     the *prompt* assertable, which is how the line budget is checked.
 *   - `PI_CODING_AGENT_DIR` points at the sandbox, so `recap.json` is read and
 *     written there and the user's real config is never touched.
 *
 * Not covered: the idle trigger itself. It hangs off a 30s interval with no
 * override, so testing it would mean either a 30s sleep or a fake clock; the
 * surfacing path it calls (`injectRecap`) is driven directly by `/recap`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const SANDBOX = mkdtempSync(join(tmpdir(), "recap-test-"));
const SCOPE = join(SANDBOX, "node_modules", "@earendil-works");

mkdirSync(SCOPE, { recursive: true });
symlinkSync(join(PI_DIR, "node_modules", "@earendil-works", "pi-tui"), join(SCOPE, "pi-tui"));
symlinkSync(PI_DIR, join(SCOPE, "pi-coding-agent"));

// Stub provider package: `complete` records its call and answers from `state`.
const AI = join(SCOPE, "pi-ai");
mkdirSync(AI, { recursive: true });
writeFileSync(
	join(AI, "package.json"),
	JSON.stringify({
		name: "@earendil-works/pi-ai",
		version: "0.0.0",
		type: "module",
		exports: { ".": "./index.mjs", "./compat": "./compat.mjs" },
	}),
);
writeFileSync(join(AI, "index.mjs"), "export const uuidv7 = () => '00000000-0000-7000-8000-000000000000';\n");
writeFileSync(
	join(AI, "compat.mjs"),
	[
		"export const calls = [];",
		"export const state = { reply: '' };",
		"export async function complete(model, request, options) {",
		"  calls.push({ model, request, options });",
		"  return { content: [{ type: 'text', text: state.reply }] };",
		"}",
		"",
	].join("\n"),
);

const BUILT = join(SANDBOX, "recap.mjs");
execFileSync(join(PI_DIR, "node_modules", ".bin", "esbuild"), [
	join(import.meta.dirname, "recap.ts"),
	"--format=esm",
	"--platform=node",
	"--target=node22",
	`--outfile=${BUILT}`,
	"--log-level=error",
]);

// Read per call by the extension, but set before the import regardless.
process.env.PI_CODING_AGENT_DIR = SANDBOX;
const provider = await import(join(AI, "compat.mjs"));
const { default: extension } = await import(BUILT);

// `getMarkdownTheme()` reads a module global that a real pi host initializes at
// startup and throws without it. Imported through the same sandbox path as the
// extension, so Node resolves both to one module instance and this init counts
// for the card too. (An extension loaded by jiti gets its own module cache and
// may see this undefined — which is exactly why the card takes its colours from
// the `theme` handed to the renderer rather than the module global.)
const { initTheme } = await import(join(SCOPE, "pi-coding-agent", "dist", "index.js"));
initTheme(undefined, false);

const CONFIG = join(SANDBOX, "configs", "recap.json");
mkdirSync(dirname(CONFIG), { recursive: true });

/** Write the config the extension will read on its next call. */
function config(values) {
	writeFileSync(CONFIG, JSON.stringify(values ?? {}, null, 2));
}

const SUMMARY = [
	"## Goals",
	"",
	"- Ship the recap widget",
	"- Keep the transcript surface available",
	"",
	"## Open",
	"",
	"- Decide the default line budget",
].join("\n");

// ---------------------------------------------------------------- fakes ----

/** Identity theme: colour is not what these tests are about, layout is. */
const THEME = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
};

const message = (role, text) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const BRANCH = [
	message("user", "add a recap widget"),
	message("assistant", "on it"),
	message("user", "make it toggleable"),
	message("assistant", "done"),
];

/** One extension instance plus the host surface it talks to. */
function host({ mode = "tui", branch = BRANCH } = {}) {
	const state = { handlers: new Map(), commands: new Map(), shortcuts: new Map(), renderers: new Map() };
	const seen = { widgets: [], entries: [], notices: [] };

	extension({
		on: (event, handler) => state.handlers.set(event, handler),
		registerCommand: (name, options) => state.commands.set(name, options),
		registerShortcut: (key, options) => state.shortcuts.set(key, options),
		registerEntryRenderer: (type, renderer) => state.renderers.set(type, renderer),
		appendEntry: (type, data) => seen.entries.push({ type, data }),
	});

	const ctx = {
		mode,
		cwd: "/tmp/project",
		model: { provider: "stub", id: "stub-model" },
		modelRegistry: {
			find: (provider, id) => ({ provider, id }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		sessionManager: { getBranch: () => branch },
		isIdle: () => true,
		ui: {
			notify: (message, level) => seen.notices.push({ message, level }),
			setWidget: (key, content, options) => seen.widgets.push({ key, content, options }),
		},
	};

	const fire = async (event, payload = {}) => {
		const handler = state.handlers.get(event);
		if (handler) await handler(payload, ctx);
	};

	/** Last widget payload, rendered to lines. `null` once the slot is cleared. */
	const widget = (width = 60) => {
		const last = seen.widgets[seen.widgets.length - 1];
		if (!last || last.content === undefined) return null;
		return last.content(undefined, THEME).render(width);
	};

	return {
		state,
		seen,
		ctx,
		fire,
		widget,
		widgetText: (width) => (widget(width) ?? []).join("\n"),
		/** The live widget component, for mouse dispatch. Rendered first: a
		 *  Container only knows its children's heights once it has laid them out. */
		component: (width = 60) => {
			const last = seen.widgets[seen.widgets.length - 1];
			const built = last.content(undefined, THEME);
			built.render(width);
			return built;
		},
		command: (args = "") => state.commands.get("recap").handler(args, ctx),
		idleCommand: (args = "") => state.commands.get("recap-idle").handler(args, ctx),
		shortcut: () => state.shortcuts.get("ctrl+shift+r").handler(ctx),
		start: async () => {
			await fire("session_start", { reason: "startup" });
			seen.widgets.length = 0;
		},
		prompt: () => provider.calls[provider.calls.length - 1].request.messages[0].content[0].text,
	};
}

/** Non-blank rendered lines of the markdown body, ignoring rules and padding. */
function bodyLines(lines) {
	return lines.slice(1, -1).filter((line) => line.trim().length > 0);
}

/** A normalized left click at row `y`, as fullscreen mode would deliver it. */
function click(y, { type = "click", button = "left", height = 20 } = {}) {
	return {
		type,
		button,
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 60,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

/** The toggle is deferred a microtask, so let it land before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------- tests ----

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a generated recap opens as a widget above the editor", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();

	const last = h.seen.widgets[h.seen.widgets.length - 1];
	assert.equal(last.key, "recap");
	assert.equal(last.options.placement, "aboveEditor");
	assert.match(h.widgetText(), /Goals/, "the card body should be rendered");
	assert.equal(h.seen.entries.length, 0, "widget surface must not also write a session entry");
});

test("the widget closes to a single line rather than vanishing", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	await h.command("hide");

	const lines = h.widget();
	assert.equal(lines.length, 1, "a closed card is one line");
	assert.match(lines[0], /Recap/, "it must still say a recap exists");
	assert.match(lines[0], /ctrl\+shift\+r/, "and how to get it back");
});

test("show reopens the closed card without generating again", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	const before = provider.calls.length;

	await h.command("hide");
	await h.command("show");

	assert.equal(provider.calls.length, before, "reopening must not cost an LLM call");
	assert.match(h.widgetText(), /Goals/);
});

test("the shortcut toggles open and closed", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();

	await h.shortcut();
	assert.equal(h.widget().length, 1, "first press closes");
	await h.shortcut();
	assert.ok(h.widget().length > 1, "second press reopens");
});

test("the shortcut generates when there is nothing to show yet", async () => {
	config({});
	const h = host();
	await h.start();
	const before = provider.calls.length;

	await h.shortcut();

	assert.equal(provider.calls.length, before + 1, '"open the recap" with none should make one');
	assert.match(h.widgetText(), /Goals/);
});

test("clicking the header rule closes an open card", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();

	const result = h.component().handleMouse(click(0));
	assert.equal(result.handled, true, "the click must not fall through to the transcript");
	await settle();

	assert.equal(h.widget().length, 1, "the card collapsed");
});

test("clicking the collapsed line reopens it", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	await h.command("hide");
	const before = provider.calls.length;

	h.component().handleMouse(click(0, { height: 1 }));
	await settle();

	assert.ok(h.widget().length > 1, "the card reopened");
	assert.equal(provider.calls.length, before, "reopening by click must not cost an LLM call");
});

test("clicking the body of an open card leaves it open", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	const open = h.widget().length;

	const result = h.component().handleMouse(click(3));
	await settle();

	assert.equal(result, undefined, "an unclaimed click belongs to the TUI");
	assert.equal(h.widget().length, open, "reading the card must not collapse it");
});

test("drag and wheel are left to the TUI so selection and scrolling still work", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	const open = h.widget().length;

	assert.equal(h.component().handleMouse(click(0, { type: "drag" })), undefined);
	assert.equal(h.component().handleMouse(click(0, { type: "wheel", button: "none" })), undefined);
	assert.equal(h.component().handleMouse(click(0, { button: "right" })), undefined);
	await settle();

	assert.equal(h.widget().length, open, "only a left click toggles");
});

test("clear drops the widget entirely", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	await h.command("clear");

	assert.equal(h.widget(), null, "the slot is emptied, not collapsed");
});

test('surface "transcript" keeps the old append-to-session behaviour', async () => {
	config({ surface: "transcript" });
	const h = host();
	await h.start();
	await h.command();

	assert.equal(h.seen.entries.length, 1);
	assert.equal(h.seen.entries[0].type, "recap");
	assert.equal(h.widget(), null, "no widget in transcript mode");
});

test('surface "both" writes the entry and shows the widget', async () => {
	config({ surface: "both" });
	const h = host();
	await h.start();
	await h.command();

	assert.equal(h.seen.entries.length, 1);
	assert.match(h.widgetText(), /Goals/);
});

test("widget verbs report when the widget surface is off", async () => {
	config({ surface: "transcript" });
	const h = host();
	await h.start();
	const before = provider.calls.length;

	await h.command("toggle");

	assert.equal(provider.calls.length, before, "must not silently generate instead");
	assert.equal(h.seen.notices[h.seen.notices.length - 1].level, "warning");
});

test("an unknown surface falls back to the default rather than disabling both", async () => {
	config({ surface: "somewhere-else" });
	const h = host();
	await h.start();
	await h.command();

	assert.match(h.widgetText(), /Goals/);
	assert.equal(h.seen.entries.length, 0);
});

test("the prompt asks for what the active surface can show", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	assert.match(h.prompt(), /at most 6 lines/, "widget budget");

	config({ surface: "transcript" });
	await h.command();
	assert.match(h.prompt(), /at most 10 lines/, "transcript budget is the larger one");

	config({ surface: "both" });
	await h.command();
	assert.match(h.prompt(), /at most 10 lines/, '"both" writes the uncut copy to the transcript');
});

test("the prompt asks for next steps, off-budget and omittable", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();

	assert.match(h.prompt(), /"Next steps"/, "the section has to be asked for by name");
	assert.match(h.prompt(), /at most 2 bullets/, "bounded, or it eats the card");
	assert.match(h.prompt(), /do not count against the limit/, "body budget must not be spent on it");
	assert.match(h.prompt(), /omit the section entirely/, "no filler when nothing is pending");
});

test("next steps survive a body long enough to blow the budget", async () => {
	// The regression this guards: one shared cap truncates from the end, so the
	// section would vanish exactly on the dense recaps where it is most useful.
	config({});
	provider.state.reply = [
		...Array.from({ length: 20 }, (_, i) => `- point ${i + 1}`),
		"",
		"## Next steps",
		"",
		"- Run the tests",
	].join("\n");
	const h = host();
	await h.start();
	await h.command();

	const text = h.widgetText();
	assert.match(text, /Next steps/, "the section must outlive the body it follows");
	assert.match(text, /Run the tests/, "including its actions");
	assert.match(text, /…/, "the body is what gets cut");
	provider.state.reply = SUMMARY;
});

test("an over-long next steps list is capped too", async () => {
	config({});
	provider.state.reply = [
		"## Goals",
		"",
		"- Ship it",
		"",
		"## Next steps",
		"",
		...Array.from({ length: 9 }, (_, i) => `- action ${i + 1}`),
	].join("\n");
	const h = host();
	await h.start();
	await h.command();

	const body = bodyLines(h.widget());
	assert.ok(body.length <= 3 + 3 + 1, `next steps must not grow without bound, got ${body.length} lines`);
	assert.match(h.widgetText(), /action 1/, "the first actions are the ones kept");
	provider.state.reply = SUMMARY;
});

test("a next steps heading with nothing under it is dropped", async () => {
	config({});
	provider.state.reply = `${SUMMARY}\n\n## Next steps\n`;
	const h = host();
	await h.start();
	await h.command();

	const text = h.widgetText();
	assert.ok(!/Next steps/.test(text), `a dangling header costs a line and says nothing:\n${text}`);
	assert.match(text, /Goals/, "the body is untouched");
	provider.state.reply = SUMMARY;
});

test("a repeated next steps heading cannot strand the body", async () => {
	config({});
	provider.state.reply = ["## Next steps", "", "- Draft it", "", "## Next steps", "", "- Land it"].join("\n");
	const h = host();
	await h.start();
	await h.command();

	const text = h.widgetText();
	assert.match(text, /Draft it/, "content before the last heading stays in the body");
	assert.match(text, /Land it/);
	provider.state.reply = SUMMARY;
});

test("the widget body is capped at the widget budget, counting only content", async () => {
	config({});
	provider.state.reply = Array.from({ length: 20 }, (_, i) => `- point ${i + 1}\n`).join("\n");
	const h = host();
	await h.start();
	await h.command();

	const body = bodyLines(h.widget());
	assert.ok(body.length <= 7, `expected at most 6 content lines plus a truncation marker, got ${body.length}`);
	assert.match(h.widgetText(), /…/, "an over-long summary must be marked as cut");
	provider.state.reply = SUMMARY;
});

test("a model-emitted title is dropped so it cannot duplicate the card header", async () => {
	config({});
	provider.state.reply = `# Recap\n\n${SUMMARY}`;
	const h = host();
	await h.start();
	await h.command();

	const body = bodyLines(h.widget()).join("\n");
	assert.ok(!/^\s*#?\s*Recap\s*$/m.test(body), `redundant title survived:\n${body}`);
	assert.match(body, /Goals/);
	provider.state.reply = SUMMARY;
});

test("a new session does not inherit the previous conversation's recap", async () => {
	config({});
	const h = host();
	await h.start();
	await h.command();
	assert.match(h.widgetText(), /Goals/);

	await h.fire("session_start", { reason: "new" });

	assert.equal(h.widget(), null, "the card describes a branch that is gone");
});

test("the transcript renderer and the widget draw the same card", async () => {
	config({ surface: "both" });
	const h = host();
	await h.start();
	await h.command();

	const entry = h.seen.entries[0];
	const rendered = h.state.renderers.get("recap")({ data: entry.data }, {}, THEME).render(60);
	assert.match(rendered.join("\n"), /Goals/);
	assert.equal(rendered[0].length > 0, true, "the header rule is inlined, not a blank line");
});

test("an empty summary surfaces nothing at all", async () => {
	config({});
	provider.state.reply = "";
	const h = host();
	await h.start();
	await h.command();

	assert.equal(h.widget(), null);
	assert.equal(h.seen.entries.length, 0);
	provider.state.reply = SUMMARY;
});

test("non-tui modes get no widget, since there is nowhere to draw it", async () => {
	config({ surface: "both" });
	const h = host({ mode: "rpc" });
	await h.fire("session_start", { reason: "startup" });
	h.seen.widgets.length = 0;
	await h.command();

	assert.equal(h.seen.widgets.length, 0, "setWidget is a no-op outside the TUI");
	assert.equal(h.seen.entries.length, 1, "the transcript surface still works");
});

test("/recap-idle persists the threshold without losing the surface", async () => {
	config({ surface: "both" });
	const h = host();
	await h.start();
	await h.idleCommand("7");

	const written = JSON.parse(execFileSync("cat", [CONFIG], { encoding: "utf8" }));
	assert.equal(written.idleMinutes, 7);
	assert.equal(written.surface, "both", "an unrelated setting must survive the write");
});

// ----------------------------------------------------------------- run ----

provider.state.reply = SUMMARY;

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
