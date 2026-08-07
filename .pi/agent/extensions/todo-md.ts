/**
 * todo-md — repo-scoped todo list backed by a plain `todo.md` file.
 *
 * Unlike the bundled `todo.ts` example (which stores state in session entries so
 * it rewinds correctly when you branch), this one persists to a file at the git
 * root. That trades branch-correctness for the thing we actually want: a list
 * that survives across sessions and is committable/hand-editable.
 *
 * Surfaces:
 *   - `todo` tool          — LLM-callable: list / add / toggle / remove / clear_done
 *   - `/todos`             — full-list overlay
 *   - `/todos hide|show`   — toggle the always-on widget above the editor
 *   - widget               — compact open-item summary, auto-hides when empty
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";

const FILENAME = "todo.md";
const WIDGET_KEY = "todo-md";
const WIDGET_MAX_ITEMS = 3;

/** A checkbox line parsed out of todo.md. `id` is its 1-based ordinal among todos. */
interface Todo {
	id: number;
	text: string;
	done: boolean;
	/** Index into the raw line array, so we can round-trip non-todo lines verbatim. */
	line: number;
}

interface TodoFile {
	path: string;
	lines: string[];
	todos: Todo[];
	/** False when todo.md does not exist yet. */
	exists: boolean;
}

interface TodoDetails {
	action: string;
	todos: Pick<Todo, "id" | "text" | "done">[];
	path: string;
	error?: string;
}

const TODO_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$/;

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "remove", "clear_done"] as const),
	text: Type.Optional(
		Type.String({
			description: "Todo text for `add`. Multiple lines are added as separate items.",
		}),
	),
	id: Type.Optional(Type.Number({ description: "Todo id for `toggle` / `remove`" })),
});

function parse(path: string, raw: string | undefined): TodoFile {
	const exists = raw !== undefined;
	const lines = exists && raw.length > 0 ? raw.replace(/\n$/, "").split("\n") : [];
	const todos: Todo[] = [];

	lines.forEach((line, index) => {
		const match = TODO_RE.exec(line);
		if (!match) return;
		todos.push({
			id: todos.length + 1,
			text: match[4].trim(),
			done: match[2] !== " ",
			line: index,
		});
	});

	return { path, lines, todos, exists };
}

function serialize(file: TodoFile): string {
	return `${file.lines.join("\n").replace(/\n+$/, "")}\n`;
}

function renderPlain(file: TodoFile): string {
	if (file.todos.length === 0) return "No todos.";
	const done = file.todos.filter((t) => t.done).length;
	const body = file.todos.map((t) => `${t.id}. [${t.done ? "x" : " "}] ${t.text}`).join("\n");
	return `${done}/${file.todos.length} done\n${body}`;
}

/** Overlay shown by `/todos`. */
class TodoOverlay {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private file: TodoFile,
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", ` ${FILENAME} `);
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
				width,
			),
		);
		lines.push("");

		if (!this.file.exists) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `No ${this.file.path} yet — ask the agent to add a todo.`)}`, width));
		} else if (this.file.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos in this file yet.")}`, width));
		} else {
			const done = this.file.todos.filter((t) => t.done).length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.file.todos.length} completed`)}`, width));
			lines.push("");
			for (const todo of this.file.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `${todo.id}.`.padEnd(3));
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Compact always-on widget rendered above the editor. */
class TodoWidget {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private todos: Pick<Todo, "id" | "text" | "done">[],
		private theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const open = this.todos.filter((t) => !t.done);
		const done = this.todos.length - open.length;

		const lines = [
			truncateToWidth(
				`${th.fg("accent", FILENAME)} ${th.fg("borderMuted", "─")} ${th.fg("muted", `${done}/${this.todos.length}`)}`,
				width,
			),
		];

		for (const todo of open.slice(0, WIDGET_MAX_ITEMS)) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "○")} ${th.fg("muted", todo.text)}`, width));
		}
		if (open.length > WIDGET_MAX_ITEMS) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `… ${open.length - WIDGET_MAX_ITEMS} more`)}`, width));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let widgetVisible = true;
	const rootCache = new Map<string, string>();

	/** Resolve the git root for a cwd, falling back to the cwd itself. */
	const resolveRoot = async (cwd: string): Promise<string> => {
		const cached = rootCache.get(cwd);
		if (cached) return cached;

		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => undefined);
		const root = result?.stdout.trim() || cwd;
		rootCache.set(cwd, root);
		return root;
	};

	const load = async (ctx: ExtensionContext): Promise<TodoFile> => {
		const path = join(await resolveRoot(ctx.cwd), FILENAME);
		const raw = await readFile(path, "utf8").catch(() => undefined);
		return parse(path, raw);
	};

	const save = async (file: TodoFile): Promise<void> => {
		await writeFile(file.path, serialize(file), "utf8");
	};

	/**
	 * Push current state into the widget. Recreates the component each time —
	 * it is a handful of lines, so there is no state worth preserving, and this
	 * avoids holding a TUI reference that goes stale on session replacement.
	 */
	const refreshWidget = async (ctx: ExtensionContext, preloaded?: TodoFile): Promise<void> => {
		if (!ctx.hasUI) return;

		if (!widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const file = preloaded ?? (await load(ctx));
		// Nothing to show: stay out of the way entirely in repos with no todo.md.
		if (file.todos.length === 0 || file.todos.every((t) => t.done)) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const snapshot = file.todos.map(({ id, text, done }) => ({ id, text, done }));
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new TodoWidget(snapshot, theme), { placement: "aboveEditor" });
	};

	// Always use the ctx handed to the handler; a captured ctx throws on every
	// getter once its session is replaced.
	pi.on("session_start", async (_event, ctx) => refreshWidget(ctx));
	// Catches todo.md edits made through the normal write/edit tools, or by hand.
	pi.on("agent_end", async (_event, ctx) => refreshWidget(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			`Manage the repo's ${FILENAME} task list. Actions:\n` +
			"- list: show all todos\n" +
			"- add: append todos (`text`; newlines create separate items)\n" +
			"- toggle: flip done state of `id`\n" +
			"- remove: delete `id`\n" +
			"- clear_done: delete all completed todos\n" +
			"Ids are positional and shift after remove/clear_done — every result returns the refreshed list, so use those ids.",
		// Rendered as `- <name>: <snippet>`, so no "todo:" prefix here.
		promptSnippet: `read/update the repo's ${FILENAME} task list that persists across sessions`,
		promptGuidelines: [
			`Use the todo tool for work the user wants tracked in ${FILENAME} across sessions, not as scratch state for a single reply.`,
			"Mark items done with the todo tool as you complete them rather than rewriting todo.md by hand.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const file = await load(ctx);

			const fail = (error: string) => ({
				content: [{ type: "text" as const, text: `Error: ${error}` }],
				isError: true,
				details: { action: params.action, todos: [], path: file.path, error } satisfies TodoDetails,
			});

			switch (params.action) {
				case "list":
					break;

				case "add": {
					const texts = (params.text ?? "")
						.split("\n")
						.map((t) => t.replace(/^\s*[-*]\s*(\[[ xX]\])?\s*/, "").trim())
						.filter(Boolean);
					if (texts.length === 0) return fail("`text` is required for add");

					const entries = texts.map((t) => `- [ ] ${t}`);
					const last = file.todos.at(-1);
					if (last) {
						file.lines.splice(last.line + 1, 0, ...entries);
					} else {
						if (!file.exists) file.lines.push("# Todo", "");
						else if (file.lines.at(-1)?.trim()) file.lines.push("");
						file.lines.push(...entries);
					}
					await save(file);
					break;
				}

				case "toggle": {
					if (params.id === undefined) return fail("`id` is required for toggle");
					const todo = file.todos.find((t) => t.id === params.id);
					if (!todo) return fail(`no todo with id ${params.id}`);

					file.lines[todo.line] = file.lines[todo.line].replace(TODO_RE, (_m, a, marker, c, d) =>
						`${a}${marker === " " ? "x" : " "}${c}${d}`,
					);
					await save(file);
					break;
				}

				case "remove": {
					if (params.id === undefined) return fail("`id` is required for remove");
					const todo = file.todos.find((t) => t.id === params.id);
					if (!todo) return fail(`no todo with id ${params.id}`);

					file.lines.splice(todo.line, 1);
					await save(file);
					break;
				}

				case "clear_done": {
					const doomed = file.todos.filter((t) => t.done).map((t) => t.line);
					if (doomed.length === 0) return fail("no completed todos to clear");
					// Descending, so earlier indices stay valid as we splice.
					for (const line of doomed.sort((a, b) => b - a)) file.lines.splice(line, 1);
					await save(file);
					break;
				}
			}

			// Re-read so the returned ids match what is now on disk.
			const updated = params.action === "list" ? file : parse(file.path, serialize(file));
			await refreshWidget(ctx, updated);

			return {
				content: [{ type: "text" as const, text: renderPlain(updated) }],
				details: {
					action: params.action,
					todos: updated.todos.map(({ id, text, done }) => ({ id, text, done })),
					path: updated.path,
				} satisfies TodoDetails,
			};
		},
	});

	pi.registerCommand("todos", {
		description: `Show ${FILENAME} (args: hide | show)`,
		getArgumentCompletions: (prefix) =>
			["hide", "show"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),

		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "hide" || arg === "show") {
				widgetVisible = arg === "show";
				await refreshWidget(ctx);
				ctx.ui.notify(`todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
				return;
			}

			const file = await load(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(renderPlain(file), "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoOverlay(file, theme, () => done()));
		},
	});
}
