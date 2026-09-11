/**
 * todo-md — per-session todo list backed by a plain markdown file.
 *
 * Unlike the bundled `todo.ts` example (state in session entries, so it rewinds
 * when you branch a session), this one persists to a file, which is what makes a
 * list survive a resume and stay hand-editable. Unlike the version it replaces,
 * the file is per *session* rather than one `todo.md` at the git root: several
 * agents working the same repo each get their own list instead of trampling a
 * shared one.
 *
 * Storage (see `resolveTarget`):
 *   session (default)   <agent-dir>/todos/<project-key>/todo-<sessionId>.md
 *   project             <git-root>/todo.md
 *   PI_TODOS=<name>     <agent-dir>/todos/shared/<name>.md — deliberate sharing
 *   PI_TODOS=<path>     that file
 *   PI_TODOS=off        memory only
 *
 * The default lives outside the repo on purpose: a list keyed by session id is
 * runtime state, meaningless to anyone who clones, and in-repo it would cost a
 * `.gitignore` rule per project.
 *
 * Surfaces:
 *   - `todo` tool          — list / add / start / toggle / remove / clear_done
 *   - `/todos`             — full-list overlay
 *   - `/todos sessions`    — the project's other session lists
 *   - `/todos hide|show`   — toggle the always-on widget above the editor
 *   - widget               — status glyphs, spinner on in-progress items
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";

const WIDGET_KEY = "todo-md";
const CONFIG_FILENAME = "todo-md-config.json";
const PROJECT_FILENAME = "todo.md";
const SPINNER_INTERVAL_MS = 150;
/** A write takes milliseconds; a lock older than this belongs to a dead process. */
const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 2_000;
const MAX_SESSION_ROWS = 20;

// ---------------------------------------------------------------- model ----

type Status = "pending" | "in_progress" | "completed";

/** A checkbox line parsed out of the file. `id` is its 1-based ordinal. */
interface Todo {
	id: number;
	text: string;
	status: Status;
	/** Index into the raw line array, so non-todo lines round-trip verbatim. */
	line: number;
}

type Scope = "session" | "project" | "shared" | "explicit" | "memory";

interface Target {
	/** Absolute path, or undefined for the in-memory list. */
	path?: string;
	scope: Scope;
	/** Shown in the widget header when the list is not this session's own. */
	label?: string;
	/** Session files are single-writer; anything else can be raced by other agents. */
	shared: boolean;
	/** Session files delete themselves once the last item goes. */
	ephemeral: boolean;
}

interface TodoFile {
	target: Target;
	lines: string[];
	todos: Todo[];
	/** False when the file does not exist yet. */
	exists: boolean;
}

interface TodoDetails {
	action: string;
	todos: Pick<Todo, "id" | "text" | "status">[];
	path: string;
	scope: Scope;
	error?: string;
}

const MEMORY_TARGET: Target = { scope: "memory", label: "memory", shared: false, ephemeral: false };

/** `[ ]` pending, `[x]` done, `[/]` in progress — `[-]` and `[~]` are read as the
 *  same in-progress convention other markdown tools write. */
const TODO_RE = /^(\s*[-*]\s+\[)([ xX\/~-])(\]\s*)(.*)$/;
const MARKERS: Record<Status, string> = { pending: " ", in_progress: "/", completed: "x" };

function statusOf(marker: string): Status {
	if (marker === " ") return "pending";
	return marker === "x" || marker === "X" ? "completed" : "in_progress";
}

function parseLines(raw: string | undefined): Pick<TodoFile, "lines" | "todos" | "exists"> {
	const exists = raw !== undefined;
	const lines = exists && raw.length > 0 ? raw.replace(/\n$/, "").split("\n") : [];
	const todos: Todo[] = [];

	lines.forEach((line, index) => {
		const match = TODO_RE.exec(line);
		if (!match) return;
		todos.push({ id: todos.length + 1, text: match[4].trim(), status: statusOf(match[2]), line: index });
	});

	return { lines, todos, exists };
}

function serialize(file: TodoFile): string {
	return `${file.lines.join("\n").replace(/\n+$/, "")}\n`;
}

function setStatus(file: TodoFile, todo: Todo, status: Status): void {
	file.lines[todo.line] = file.lines[todo.line].replace(
		TODO_RE,
		(_m, open, _marker, close, text) => `${open}${MARKERS[status]}${close}${text}`,
	);
}

interface Counts {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
}

function count(todos: readonly Pick<Todo, "status">[]): Counts {
	return {
		total: todos.length,
		completed: todos.filter((t) => t.status === "completed").length,
		inProgress: todos.filter((t) => t.status === "in_progress").length,
		pending: todos.filter((t) => t.status === "pending").length,
	};
}

/** `5 todos (2 done, 1 in progress, 2 open)` — empty groups are left out. */
function summarize(counts: Counts): string {
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed} done`);
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} open`);
	const noun = counts.total === 1 ? "todo" : "todos";
	return parts.length > 0 ? `${counts.total} ${noun} (${parts.join(", ")})` : `${counts.total} ${noun}`;
}

// --------------------------------------------------------------- glyphs ----

/** Everything the widget and overlay are drawn with. */
interface Glyphs {
	completed: string;
	inProgress: string;
	pending: string;
	/** One frame per widget tick, on the row being worked right now. */
	spinner: readonly string[];
	/** Stands in for the rows `collapseCompleted` folds away. */
	completedSummary: string;
	/** Bullet on the widget's summary line. */
	header: string;
	/** The `and N more` line standing in for rows the visible limit hid. */
	overflow: string;
	/** Closes an in-progress row, marking it as still running. */
	trailingEllipsis: string;
	/** Marks a line clipped at the terminal's right edge. */
	truncation: string;
}

const DEFAULT_GLYPHS: Omit<Glyphs, "completedSummary"> = {
	completed: "✔",
	inProgress: "◼",
	pending: "◻",
	spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
	header: "●",
	overflow: "…",
	trailingEllipsis: "…",
	truncation: "...",
};

/** Control characters break the one-line-per-row contract or steer the terminal
 *  itself (`ESC ]0;…` retitles the window); bidi overrides reorder the line around
 *  the glyph. Config is hand-edited and may arrive with a cloned repo. */
const UNSAFE_GLYPH = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

const isGlyph = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && !UNSAFE_GLYPH.test(value);

/** Resolve configured glyphs against the defaults. Never throws: each glyph falls
 *  back on its own, the spinner as a whole — half a frame sequence is no animation. */
function resolveGlyphs(raw: unknown): Glyphs {
	const cfg = asRecord(raw);
	const pick = (key: keyof typeof DEFAULT_GLYPHS, fallback: string) => (isGlyph(cfg[key]) ? (cfg[key] as string) : fallback);
	const spinner = cfg.spinner;
	const completed = pick("completed", DEFAULT_GLYPHS.completed);
	return {
		completed,
		inProgress: pick("inProgress", DEFAULT_GLYPHS.inProgress),
		pending: pick("pending", DEFAULT_GLYPHS.pending),
		spinner: Array.isArray(spinner) && spinner.length > 0 && spinner.every(isGlyph) ? spinner : DEFAULT_GLYPHS.spinner,
		// Falls back to the resolved `completed`, not a literal: a config that sets
		// only `completed` should not mark the line standing in for those rows differently.
		completedSummary: isGlyph(cfg.completedSummary) ? (cfg.completedSummary as string) : completed,
		header: pick("header", DEFAULT_GLYPHS.header),
		overflow: pick("overflow", DEFAULT_GLYPHS.overflow),
		trailingEllipsis: pick("trailingEllipsis", DEFAULT_GLYPHS.trailingEllipsis),
		truncation: pick("truncation", DEFAULT_GLYPHS.truncation),
	};
}

// --------------------------------------------------------------- config ----

type SortOrder = "id" | "status" | "active";

interface Config {
	scope: "session" | "project";
	sortOrder: SortOrder;
	collapseCompleted: boolean;
	maxVisible: number;
	showAll: boolean;
	hiddenAt: "top" | "bottom";
	/** Drop the widget entirely once every item is done. */
	hideWhenComplete: boolean;
	glyphs: Glyphs;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Config is data, never code — and a hand-edited file must not break the widget,
 *  so every value is validated on its own and falls back on its own. */
function resolveConfig(raw: Record<string, unknown>): Config {
	const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
		typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
	const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	const int = (value: unknown, min: number, max: number, fallback: number) =>
		typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;

	return {
		scope: oneOf(raw.scope, ["session", "project"] as const, "session"),
		sortOrder: oneOf(raw.sortOrder, ["id", "status", "active"] as const, "id"),
		collapseCompleted: bool(raw.collapseCompleted, false),
		maxVisible: int(raw.maxVisible, 1, 100, 5),
		showAll: bool(raw.showAll, false),
		hiddenAt: oneOf(raw.hiddenAt, ["top", "bottom"] as const, "bottom"),
		hideWhenComplete: bool(raw.hideWhenComplete, true),
		glyphs: resolveGlyphs(raw.glyphs),
	};
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	const raw = await readFile(path, "utf8").catch(() => undefined);
	if (raw === undefined) return {};
	try {
		return asRecord(JSON.parse(raw));
	} catch {
		return {};
	}
}

/** Global defaults under the agent dir, overridden key by key per project. */
async function loadConfig(root: string): Promise<Config> {
	const [global, project] = await Promise.all([
		readJson(join(getAgentDir(), CONFIG_FILENAME)),
		readJson(join(root, ".pi", CONFIG_FILENAME)),
	]);
	return resolveConfig({
		...global,
		...project,
		glyphs: { ...asRecord(global.glyphs), ...asRecord(project.glyphs) },
	});
}

// ---------------------------------------------------------------- paths ----

/**
 * Directory name standing for one workspace, encoded the way pi encodes its own
 * session logs (`--Users-me-work-repo--`), so a project's todo files sit under the
 * same name as its transcripts. Keyed off the git root, so every worktree — one
 * per parallel agent, under worktrunk — gets its own bucket.
 */
function projectKey(root: string): string {
	return `--${resolve(root).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Resolved per call, never captured: `getAgentDir()` reads the environment. */
function sessionTodosDir(root: string): string {
	return join(getAgentDir(), "todos", projectKey(root));
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		// No session file means nothing to key a file to (`pi --no-session`).
		return ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionId() : undefined;
	} catch {
		return undefined;
	}
}

function resolveTarget(ctx: ExtensionContext, root: string, config: Config): Target {
	const env = process.env.PI_TODOS?.trim();
	if (env) {
		if (env === "off") return MEMORY_TARGET;
		if (env.includes("/") || env.endsWith(".md")) {
			const path = isAbsolute(env) ? env : resolve(root, env);
			return { path, scope: "explicit", label: basename(path), shared: true, ephemeral: false };
		}
		return {
			path: join(getAgentDir(), "todos", "shared", `${env}.md`),
			scope: "shared",
			label: env,
			shared: true,
			ephemeral: false,
		};
	}

	if (config.scope === "project") {
		return { path: join(root, PROJECT_FILENAME), scope: "project", label: PROJECT_FILENAME, shared: true, ephemeral: false };
	}

	const sessionId = sessionIdOf(ctx);
	if (!sessionId) return MEMORY_TARGET;
	return { path: join(sessionTodosDir(root), `todo-${sessionId}.md`), scope: "session", shared: false, ephemeral: true };
}

function describeTarget(target: Target): string {
	return target.path ?? "in memory (no session)";
}

/** For display only — a session path is ~95 chars, which clips the line it shares. */
function tilde(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ------------------------------------------------------------------- io ----

/** Backs `PI_TODOS=off` and sessions pi is not persisting. */
let memoryContent: string | undefined;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Serialize read-modify-write on a file other agents may also hold.
 *
 * `mkdir` is the atomic primitive. A lock older than `LOCK_STALE_MS` is stolen —
 * its owner died mid-write — and waiting out `LOCK_WAIT_MS` proceeds anyway:
 * losing the user's item is worse than an interleaved write.
 */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	let held = false;

	// Without this the first shared write spins: `mkdir` fails because the parent
	// is missing, `stat` fails too, and a missing lock reads as a stale one.
	await mkdir(dirname(path), { recursive: true }).catch(() => {});

	while (!held && Date.now() <= deadline) {
		try {
			await mkdir(lock);
			held = true;
		} catch {
			const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
			// An owner that died mid-write left it behind; take it.
			if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true }).catch(() => {});
			else await sleep(50);
		}
	}

	try {
		return await fn();
	} finally {
		if (held) await rm(lock, { recursive: true, force: true }).catch(() => {});
	}
}

const withTarget = <T>(target: Target, fn: () => Promise<T>): Promise<T> =>
	target.shared && target.path ? withLock(target.path, fn) : fn();

async function load(target: Target): Promise<TodoFile> {
	const raw = target.path ? await readFile(target.path, "utf8").catch(() => undefined) : memoryContent;
	return { target, ...parseLines(raw) };
}

async function save(file: TodoFile): Promise<void> {
	const { target } = file;
	const text = serialize(file);

	if (!target.path) {
		memoryContent = text;
		return;
	}

	// Counted from the serialized text, never from `file.todos`: that array was
	// parsed before the caller edited `file.lines`, so it is one mutation stale.
	const remaining = parseLines(text).todos.length;
	// A session list that has emptied is nothing but litter under the agent dir.
	if (target.ephemeral && remaining === 0) {
		await unlink(target.path).catch(() => {});
		await rmdir(dirname(target.path)).catch(() => {});
		return;
	}

	await mkdir(dirname(target.path), { recursive: true });
	// Rename, so a concurrent reader never sees a half-written list.
	const tmp = `${target.path}.${process.pid}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, target.path);
}

// -------------------------------------------------------------- sorting ----

const RANKS: Record<SortOrder, Status[]> = {
	id: [],
	status: ["completed", "in_progress", "pending"],
	active: ["in_progress", "pending", "completed"],
};

/** Return a sorted copy. `id` is file order; every order tie-breaks on id, so the
 *  list is stable and a row does not move under the cursor between renders. */
function sortTodos<T extends { id: number; status: Status }>(todos: readonly T[], order: SortOrder): T[] {
	const rank = RANKS[order];
	return [...todos].sort((a, b) => {
		if (rank.length > 0) {
			const delta = rank.indexOf(a.status) - rank.indexOf(b.status);
			if (delta !== 0) return delta;
		}
		return a.id - b.id;
	});
}

// --------------------------------------------------------------- widget ----

interface WidgetItem {
	id: number;
	text: string;
	status: Status;
	/** When this item was first *seen* in progress — markdown carries no timestamps. */
	startedAt?: number;
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function formatAge(ms: number): string {
	return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

/** Compact always-on widget rendered above the editor. */
class TodoWidget implements Component {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly items: WidgetItem[];
	private readonly counts: Counts;
	/** Elapsed time and spinner move on their own, so caching is off while they do. */
	private readonly animated: boolean;

	constructor(
		items: WidgetItem[],
		private cfg: Config,
		private target: Target,
		private theme: Theme,
		tui: TUI,
	) {
		this.items = sortTodos(items, cfg.sortOrder);
		this.counts = count(items);
		this.animated = items.some((i) => i.status === "in_progress");

		if (this.animated) {
			this.timer = setInterval(() => {
				this.frame++;
				tui.requestRender();
			}, SPINNER_INTERVAL_MS);
			// Never a reason to hold the process open for a spinner.
			this.timer.unref?.();
		}
	}

	render(width: number): string[] {
		if (!this.animated && this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const g = this.cfg.glyphs;
		const cut = (line: string) => truncateToWidth(line, width, g.truncation);

		const label = this.target.label && this.target.scope !== "session" ? th.fg("dim", ` · ${this.target.label}`) : "";
		const lines: string[] = [
			cut(`${th.fg("accent", g.header)} ${th.fg("accent", summarize(this.counts))}${label}`),
		];

		// Collapsing decides what goes in the list; the visible limit then applies
		// to whatever remains.
		const listed = this.cfg.collapseCompleted ? this.items.filter((t) => t.status !== "completed") : this.items;
		const limit = this.cfg.maxVisible;
		const visible = this.cfg.showAll
			? listed
			: this.cfg.hiddenAt === "top"
				? listed.slice(-limit)
				: listed.slice(0, limit);

		const hidden = listed.length - visible.length;
		const overflow = hidden > 0 ? cut(th.fg("dim", `    ${g.overflow} and ${hidden} more`)) : undefined;

		if (overflow && this.cfg.hiddenAt === "top") lines.push(overflow);

		const spinner = g.spinner[this.frame % g.spinner.length];
		for (const item of visible) {
			const id = `#${item.id}`;
			if (item.status === "completed") {
				lines.push(cut(`  ${th.fg("success", g.completed)} ${th.fg("dim", th.strikethrough(`${id} ${item.text}`))}`));
			} else if (item.status === "in_progress") {
				const elapsed = item.startedAt ? th.fg("dim", ` (${formatDuration(Date.now() - item.startedAt)})`) : "";
				lines.push(
					cut(
						`  ${th.fg("accent", spinner)} ${th.fg("dim", id)} ${th.fg("accent", item.text + g.trailingEllipsis)}${elapsed}`,
					),
				);
			} else {
				lines.push(cut(`  ${g.pending} ${th.fg("dim", id)} ${th.fg("text", item.text)}`));
			}
		}

		if (overflow && this.cfg.hiddenAt !== "top") lines.push(overflow);
		if (this.cfg.collapseCompleted && this.counts.completed > 0) {
			lines.push(
				cut(`  ${th.fg("success", g.completedSummary)} ${th.fg("dim", `${this.counts.completed} completed`)}`),
			);
		}

		if (!this.animated) {
			this.cachedWidth = width;
			this.cachedLines = lines;
		}
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

// -------------------------------------------------------------- overlay ----

/** Overlay shown by `/todos` and `/todos sessions`. */
class ListOverlay implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private title: string,
		private body: (theme: Theme, width: number) => string[],
		private footer: string,
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
		const rule = th.fg("borderMuted", "───") + th.fg("accent", ` ${this.title} `);
		const lines = [
			"",
			truncateToWidth(rule + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 6))), width),
			"",
			...this.body(th, width).map((line) => truncateToWidth(line, width)),
			"",
			truncateToWidth(`  ${th.fg("dim", this.footer)}`, width),
			"",
		];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function todoBody(file: TodoFile, cfg: Config, th: Theme): string[] {
	const g = cfg.glyphs;

	if (!file.exists) return [`  ${th.fg("dim", "No todos for this session yet — ask the agent to add one.")}`];
	if (file.todos.length === 0) return [`  ${th.fg("dim", "No todos in this file yet.")}`];

	const lines = [`  ${th.fg("muted", summarize(count(file.todos)))}`, ""];
	for (const todo of sortTodos(file.todos, cfg.sortOrder)) {
		const id = th.fg("dim", `#${todo.id}`.padEnd(4));
		if (todo.status === "completed") {
			lines.push(`  ${th.fg("success", g.completed)} ${id} ${th.fg("dim", th.strikethrough(todo.text))}`);
		} else if (todo.status === "in_progress") {
			lines.push(`  ${th.fg("accent", g.inProgress)} ${id} ${th.fg("accent", todo.text)}`);
		} else {
			lines.push(`  ${g.pending} ${id} ${th.fg("text", todo.text)}`);
		}
	}
	return lines;
}

// ------------------------------------------------------------- sessions ----

interface SessionEntry {
	path: string;
	id: string;
	counts: Counts;
	modified: number;
	current: boolean;
}

/** Every session list this project has, newest first. */
async function readSessions(root: string, currentPath: string | undefined): Promise<SessionEntry[]> {
	const dir = sessionTodosDir(root);
	const names = await readdir(dir).catch(() => [] as string[]);
	const entries: SessionEntry[] = [];

	for (const name of names) {
		const match = /^todo-(.+)\.md$/.exec(name);
		if (!match) continue;
		const path = join(dir, name);
		const [raw, info] = await Promise.all([
			readFile(path, "utf8").catch(() => undefined),
			stat(path).catch(() => undefined),
		]);
		if (raw === undefined) continue;
		entries.push({
			path,
			id: match[1],
			counts: count(parseLines(raw).todos),
			modified: info?.mtimeMs ?? 0,
			current: path === currentPath,
		});
	}

	return entries.sort((a, b) => b.modified - a.modified);
}

function sessionsBody(entries: SessionEntry[], cfg: Config, th: Theme): string[] {
	if (entries.length === 0) return [`  ${th.fg("dim", "No session todo lists for this project yet.")}`];

	const lines: string[] = [];
	for (const entry of entries.slice(0, MAX_SESSION_ROWS)) {
		const glyph = entry.counts.inProgress > 0 ? cfg.glyphs.inProgress : cfg.glyphs.pending;
		const mark = entry.current ? th.fg("accent", glyph) : th.fg("dim", glyph);
		// Padded before colouring: ANSI escapes inflate `.length`, so a pad applied
		// after `th.fg` can never fire.
		const short = entry.id.slice(0, 8).padEnd(8);
		const id = entry.current ? th.fg("accent", short) : th.fg("text", short);
		const done = th.fg("muted", `${entry.counts.completed}/${entry.counts.total}`.padStart(6));
		const age = th.fg("dim", formatAge(Date.now() - entry.modified));
		const here = entry.current ? th.fg("dim", "  ← this session") : "";
		lines.push(`  ${mark} ${id}  ${done} done  ${age}${here}`);
	}
	if (entries.length > MAX_SESSION_ROWS) {
		lines.push(`  ${th.fg("dim", `${cfg.glyphs.overflow} and ${entries.length - MAX_SESSION_ROWS} more`)}`);
	}
	return lines;
}

// ----------------------------------------------------------- plain text ----

function renderPlain(file: TodoFile): string {
	if (file.todos.length === 0) return `No todos (${describeTarget(file.target)}).`;
	const body = file.todos.map((t) => `${t.id}. [${MARKERS[t.status]}] ${t.text}`).join("\n");
	return `${summarize(count(file.todos))}\n${body}`;
}

// ------------------------------------------------------------ extension ----

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "start", "toggle", "remove", "clear_done"] as const),
	text: Type.Optional(
		Type.String({ description: "Todo text for `add`. Multiple lines are added as separate items." }),
	),
	id: Type.Optional(Type.Number({ description: "Todo id for `start` / `toggle` / `remove`" })),
});

export default function (pi: ExtensionAPI) {
	let widgetVisible = true;
	const rootCache = new Map<string, string>();
	/** When each in-progress item was first seen, keyed by `<file>\0<text>`. */
	const progressStarts = new Map<string, number>();

	/** Resolve the git root for a cwd, falling back to the cwd itself. */
	const resolveRoot = async (cwd: string): Promise<string> => {
		const cached = rootCache.get(cwd);
		if (cached) return cached;

		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => undefined);
		const root = result?.stdout.trim() || cwd;
		rootCache.set(cwd, root);
		return root;
	};

	/** Everything a surface needs: where the list lives, how to draw it, what's in it. */
	const open = async (ctx: ExtensionContext, preloaded?: TodoFile) => {
		const root = await resolveRoot(ctx.cwd);
		const config = await loadConfig(root);
		const target = preloaded?.target ?? resolveTarget(ctx, root, config);
		const file = preloaded ?? (await load(target));
		return { root, config, target, file };
	};

	/**
	 * Stamp in-progress items with when they were first seen in that state, and
	 * forget the ones that have moved on. Markdown carries no timestamps, so a
	 * resumed session starts its clocks over — the alternative is writing state
	 * into a file the user hand-edits.
	 */
	const withStarts = (file: TodoFile): WidgetItem[] => {
		const prefix = `${file.target.path ?? "memory"}\0`;
		const live = new Set<string>();
		const items = file.todos.map(({ id, text, status }) => {
			if (status !== "in_progress") return { id, text, status };
			const key = prefix + text;
			live.add(key);
			const startedAt = progressStarts.get(key) ?? Date.now();
			progressStarts.set(key, startedAt);
			return { id, text, status, startedAt };
		});
		for (const key of progressStarts.keys()) {
			if (key.startsWith(prefix) && !live.has(key)) progressStarts.delete(key);
		}
		return items;
	};

	/**
	 * Push current state into the widget. Recreates the component each time — it
	 * holds nothing worth preserving, and this avoids keeping a TUI reference that
	 * goes stale on session replacement. The spinner's timer belongs to the
	 * component and dies with it: pi disposes the old one on replacement.
	 */
	const refreshWidget = async (ctx: ExtensionContext, preloaded?: TodoFile): Promise<void> => {
		if (!ctx.hasUI) return;

		if (!widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const { config, target, file } = await open(ctx, preloaded);
		const done = file.todos.every((t) => t.status === "completed");
		// Nothing to show: stay out of the way entirely.
		if (file.todos.length === 0 || (config.hideWhenComplete && done)) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const items = withStarts(file);
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new TodoWidget(items, config, target, theme, tui), {
			placement: "aboveEditor",
		});
	};

	// Always use the ctx handed to the handler; a captured ctx throws on every
	// getter once its session is replaced.
	pi.on("session_start", async (_event, ctx) => refreshWidget(ctx));
	// Catches edits made through the normal write/edit tools, by hand, or — on a
	// shared list — by another agent.
	pi.on("agent_end", async (_event, ctx) => refreshWidget(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage this session's todo list (a markdown file, one per session, kept outside the repo). Actions:\n" +
			"- list: show all todos\n" +
			"- add: append todos (`text`; newlines create separate items)\n" +
			"- start: mark `id` in progress\n" +
			"- toggle: flip `id` between done and not done\n" +
			"- remove: delete `id`\n" +
			"- clear_done: delete all completed todos\n" +
			"Ids are positional and shift after remove/clear_done — every result returns the refreshed list, so use those ids.",
		// Rendered as `- <name>: <snippet>`, so no "todo:" prefix here.
		promptSnippet: "read/update this session's todo list, which persists across resumes",
		promptGuidelines: [
			"Use the todo tool for multi-step work the user wants tracked, not as scratch state for a single reply.",
			"Mark an item in progress with `start` before working it, and done with `toggle` as you finish — do not rewrite the file by hand.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await resolveRoot(ctx.cwd);
			const config = await loadConfig(root);
			const target = resolveTarget(ctx, root, config);

			// One read-modify-write, serialized when another agent may hold the file.
			const outcome = await withTarget(target, async (): Promise<{ file: TodoFile } | { error: string }> => {
				const file = await load(target);
				const find = (id: number | undefined) =>
					id === undefined ? undefined : file.todos.find((t) => t.id === id);

				switch (params.action) {
					case "list":
						return { file };

					case "add": {
						const texts = (params.text ?? "")
							.split("\n")
							.map((t) => t.replace(/^\s*[-*]\s*(\[[ xX\/~-]\])?\s*/, "").trim())
							.filter(Boolean);
						if (texts.length === 0) return { error: "`text` is required for add" };

						const entries = texts.map((t) => `- [ ] ${t}`);
						const last = file.todos.at(-1);
						if (last) {
							file.lines.splice(last.line + 1, 0, ...entries);
						} else {
							if (!file.exists) file.lines.push("# Todo", "");
							else if (file.lines.at(-1)?.trim()) file.lines.push("");
							file.lines.push(...entries);
						}
						break;
					}

					case "start": {
						if (params.id === undefined) return { error: "`id` is required for start" };
						const todo = find(params.id);
						if (!todo) return { error: `no todo with id ${params.id}` };
						setStatus(file, todo, "in_progress");
						break;
					}

					case "toggle": {
						if (params.id === undefined) return { error: "`id` is required for toggle" };
						const todo = find(params.id);
						if (!todo) return { error: `no todo with id ${params.id}` };
						setStatus(file, todo, todo.status === "completed" ? "pending" : "completed");
						break;
					}

					case "remove": {
						if (params.id === undefined) return { error: "`id` is required for remove" };
						const todo = find(params.id);
						if (!todo) return { error: `no todo with id ${params.id}` };
						file.lines.splice(todo.line, 1);
						break;
					}

					case "clear_done": {
						const doomed = file.todos.filter((t) => t.status === "completed").map((t) => t.line);
						if (doomed.length === 0) return { error: "no completed todos to clear" };
						// Descending, so earlier indices stay valid as we splice.
						for (const line of doomed.sort((a, b) => b - a)) file.lines.splice(line, 1);
						break;
					}
				}

				await save(file);
				// Re-parse so the returned ids match what is now on disk.
				return { file: { target, ...parseLines(serialize(file)) } };
			});

			if ("error" in outcome) {
				return {
					content: [{ type: "text" as const, text: `Error: ${outcome.error}` }],
					isError: true,
					details: {
						action: params.action,
						todos: [],
						path: describeTarget(target),
						scope: target.scope,
						error: outcome.error,
					} satisfies TodoDetails,
				};
			}

			await refreshWidget(ctx, outcome.file);

			return {
				content: [{ type: "text" as const, text: renderPlain(outcome.file) }],
				details: {
					action: params.action,
					todos: outcome.file.todos.map(({ id, text, status }) => ({ id, text, status })),
					path: describeTarget(target),
					scope: target.scope,
				} satisfies TodoDetails,
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show this session's todo list (args: sessions | hide | show)",
		getArgumentCompletions: (prefix) =>
			["sessions", "hide", "show"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),

		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "hide" || arg === "show") {
				widgetVisible = arg === "show";
				await refreshWidget(ctx);
				ctx.ui.notify(`todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
				return;
			}

			const { root, config, target, file } = await open(ctx);

			if (arg === "sessions") {
				const entries = await readSessions(root, target.path);
				if (ctx.mode !== "tui") {
					const text = entries
						.map((e) => `${e.current ? "*" : " "} ${e.id}  ${e.counts.completed}/${e.counts.total} done`)
						.join("\n");
					ctx.ui.notify(text || "No session todo lists for this project yet.", "info");
					return;
				}
				await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
					new ListOverlay(
						"session todos",
						(th) => sessionsBody(entries, config, th),
						`escape to close · ${tilde(sessionTodosDir(root))}`,
						theme,
						() => done(),
					),
				);
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(renderPlain(file), "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
				new ListOverlay(
					target.scope === "session" ? "todos" : `todos · ${target.scope}`,
					(th) => todoBody(file, config, th),
					`escape to close · ${tilde(describeTarget(target))}`,
					theme,
					() => done(),
				),
			);
		},
	});
}
