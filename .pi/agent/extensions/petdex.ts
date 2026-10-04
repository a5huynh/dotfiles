/**
 * petdex — drive the Petdex desktop pet (https://petdex.dev) from pi.
 *
 * Petdex Desktop runs a hook server on 127.0.0.1:7777: `POST /state` moves the
 * pet, `POST /bubble` updates a per-session card in its "Flock" view, both
 * authenticated with a token the app rotates into ~/.petdex/runtime on every
 * boot. Petdex wires its supported agents itself, but stock pi is not one of
 * them — only the OMP fork is — so this is a port of the extension it generates
 * for OMP (packages/petdex-desktop-native/src/assets/omp-extension.ts), re-typed
 * against pi and reworked for running a dozen sessions at once.
 *
 * Event → pet state:
 *   session_start, input            jumping
 *   tool_call (read/grep/find/ls)   review
 *   tool_call (anything else)       running
 *   tool_result with isError        failed
 *   ui_prompt_start                 waiting   (heartbeat while blocked, below)
 *   agent_settled                   waving, "Done."
 *   session_shutdown                idle
 *
 * `agent_settled` rather than OMP's `agent_end`: it fires only once no
 * automatic retry, compaction or queued continuation will run, so the pet does
 * not wave "Done." between provider retries (the lesson of herdr's v8 pi
 * integration).
 *
 * Built for many concurrent sessions, which the upstream file is not:
 *
 * - Fire-and-forget. Handlers never await the network; posts are chained per
 *   session so they land in order. OMP's version awaits up to 300ms per event
 *   on pi's own event loop.
 * - Throttled. The hook server's budget is 30 req/s *shared by every agent*,
 *   and a 429 is silent. A successful tool_result posts nothing, and tool calls
 *   coalesce to at most one per COALESCE_MS per session (leading + trailing,
 *   latest wins). Attention states — waiting, failed, done — are never
 *   coalesced away.
 * - Blocked sessions stay visible. The Flock holds 8 cards and evicts the least
 *   recently *updated*, which is exactly the session that is blocked on you, so
 *   `waiting` is re-sent every WAITING_HEARTBEAT_MS. The text carries the
 *   elapsed time because that is load-bearing: the server suppresses a bubble
 *   identical to the last one *without* bumping its recency, so a verbatim
 *   heartbeat would refresh nothing.
 *
 * Not ported: OMP's session journal. Petdex replays it only for agents it
 * reconciles natively, so for `pi` it would be disk writes nobody reads.
 *
 * Off switches: `PI_PETDEX=off` per run; Petdex's own killswitch file
 * (~/.petdex/runtime/hooks-disabled) for everything at once. Inside herdr,
 * `herdr_pane_id` is sent so clicking a card focuses its pane — and the herdr
 * bridge plugin (dev.petdex.bridge) must exclude `pi`, or every pane gets a
 * second card keyed by its session *file* instead of its id.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function envMs(name: string, fallback: number): number {
	const raw = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Overridable so the offline test can point at a stub server and a temp dir. */
const HOOK_URL = (process.env.PETDEX_HOOK_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
const RUNTIME_DIR = process.env.PETDEX_RUNTIME_DIR ?? join(homedir(), ".petdex", "runtime");
const TOKEN_PATH = join(RUNTIME_DIR, "update-token");
const KILLSWITCH_PATH = join(RUNTIME_DIR, "hooks-disabled");

const AGENT_SOURCE = "pi";
/** Well above a localhost round-trip; a hung app must not pile up requests. */
const REQUEST_TIMEOUT_MS = 300;
const COALESCE_MS = envMs("PI_PETDEX_COALESCE_MS", 250);
const WAITING_HEARTBEAT_MS = envMs("PI_PETDEX_WAITING_MS", 60_000);

/** Read-only tools read as thinking rather than working, as upstream splits them. */
const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls"]);

type PetState = "idle" | "running" | "review" | "waiting" | "waving" | "jumping" | "failed";
type Status = "idle" | "running" | "needs_input" | "completed" | "failed";

type Update = {
	state: PetState;
	/** ms the state plays before the pet settles back; omitted = until replaced. */
	duration?: number;
	/** Bubble text. Without it only `/state` is posted and the card is untouched. */
	text?: string;
	busy: boolean;
	status: Status;
	messageKind?: "status" | "prompt" | "tool" | "lifecycle";
	eventKind: string;
	requestId?: string;
	resolvesRequestId?: string;
};

type Session = {
	id: string;
	cwd: string;
	/** The session's first prompt, as the card title. */
	title?: string;
	/** Serializes this session's posts so they land in the order they were made. */
	chain: Promise<void>;
	lastSentAt: number;
	pending?: Update;
	flushTimer?: ReturnType<typeof setTimeout>;
	waitTimer?: ReturnType<typeof setInterval>;
	waitingSince?: number;
	prompt?: { id: string; text: string };
	prompts: number;
};

function enabled(): boolean {
	return process.env.PI_PETDEX !== "off";
}

// ----------------------------------------------------------------- text ----

/** One line, no controls: bubble text is rendered by a native app, not a shell. */
function flatten(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

function clip(value: string, max: number): string {
	const flat = flatten(value);
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Paths keep their tail: `/Users/me/…/src/foo.rs` is useless clipped from the left. */
function clipPath(path: string, cwd: string, max: number): string {
	let shown = flatten(path);
	const rel = cwd ? relative(cwd, shown) : shown;
	if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) {
		shown = rel;
	}
	if (shown.length <= max) {
		return shown;
	}
	const name = basename(shown);
	return name.length < max ? `…${sep}${name}` : `…${name.slice(-(max - 1))}`;
}

/** A short label for what a tool call is doing, for the bubble. */
function describeTool(name: string, input: Record<string, unknown>, cwd: string, done: boolean): string {
	const field = (key: string): string | undefined => {
		const value = input?.[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const path = field("path");
	switch (name) {
		case "bash": {
			const command = field("command");
			return command ? `${done ? "Ran" : "Running"} ${clip(command, 32)}` : done ? "Ran a command" : "Running a command";
		}
		case "read":
			return `${done ? "Read" : "Reading"} ${path ? clipPath(path, cwd, 32) : "a file"}`;
		case "edit":
		case "write":
			return `${done ? "Edited" : "Editing"} ${path ? clipPath(path, cwd, 32) : "a file"}`;
		case "ls":
			return `${done ? "Listed" : "Listing"} ${path ? clipPath(path, cwd, 32) : "a directory"}`;
		case "grep":
		case "find": {
			const pattern = field("pattern");
			// Typographic quotes, as upstream: the app once read bubble bodies back
			// with a scanner that stopped at a bare `"` (petdex #628).
			return pattern ? `${done ? "Searched" : "Searching"} “${clip(pattern, 26)}”` : done ? "Searched files" : "Searching files";
		}
		default:
			return `${done ? "Ran" : "Running"} ${clip(name, 32)}`;
	}
}

function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/** The first user prompt of an already-populated session, for resume and /reload. */
function firstPrompt(ctx: ExtensionContext): string | undefined {
	try {
		for (const entry of ctx.sessionManager.getEntries() ?? []) {
			const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
			if (record?.type !== "message" || record.message?.role !== "user") {
				continue;
			}
			const content = record.message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((part) => (part as { type?: string })?.type === "text")
								.map((part) => String((part as { text?: unknown }).text ?? ""))
								.join(" ")
						: "";
			if (flatten(text)) {
				return clip(text, 60);
			}
		}
	} catch {
		// A stale or headless session manager has nothing to offer.
	}
	return undefined;
}

// -------------------------------------------------------------- network ----

async function readToken(): Promise<string | undefined> {
	try {
		return (await readFile(TOKEN_PATH, "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function postJson(path: string, body: Record<string, unknown>, token: string): Promise<void> {
	try {
		await fetch(`${HOOK_URL}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Petdex-Update-Token": token },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// App not running, rate-limited, or slow: the agent must not notice.
	}
}

async function post(session: Session, update: Update): Promise<void> {
	// Killswitch before the token read, so a disabled pet costs one stat.
	if (existsSync(KILLSWITCH_PATH)) {
		return;
	}
	// Re-read per post: the token rotates on every app boot.
	const token = await readToken();
	if (!token) {
		return;
	}

	const state: Record<string, unknown> = {
		state: update.state,
		agent_source: AGENT_SOURCE,
		session_id: session.id,
	};
	if (update.duration !== undefined) {
		state.duration = update.duration;
	}

	const posts = [postJson("/state", state, token)];
	if (update.text) {
		const bubble: Record<string, unknown> = {
			text: update.text,
			agent_source: AGENT_SOURCE,
			session_id: session.id,
			conversation_key: session.id,
			source_session_id: session.id,
			session_kind: "primary",
			busy: update.busy,
			status: update.status,
			event_kind: update.eventKind,
			// Every bubble overwrites the card's state, so the first event after a
			// failure clears the failed sprite instead of leaving it stuck.
			agent_state: update.state,
			feed_source: "hook",
		};
		if (update.messageKind) bubble.message_kind = update.messageKind;
		if (session.title) {
			bubble.title = session.title;
			bubble.title_source = "prompt";
		}
		if (session.cwd) bubble.source_cwd = session.cwd;
		const pane = process.env.HERDR_PANE_ID;
		if (pane) bubble.herdr_pane_id = pane;
		if (update.requestId) bubble.request_id = update.requestId;
		if (update.resolvesRequestId) bubble.resolves_request_id = update.resolvesRequestId;
		posts.push(postJson("/bubble", bubble, token));
	}
	await Promise.all(posts);
}

// ------------------------------------------------------------ extension ----

export default function (pi: ExtensionAPI) {
	if (!enabled()) {
		return;
	}

	/**
	 * One session per pi process at a time. Timers hold the Session object, never
	 * a ctx — pi invalidates ctx on session replacement and every getter on the
	 * stale object throws — and check it is still current before sending.
	 */
	let current: Session | undefined;

	function interactive(ctx: ExtensionContext | undefined): boolean {
		// Not `hasUI`, which is also true over RPC. See session-title.ts.
		return ctx?.mode === "tui";
	}

	function sessionId(ctx: ExtensionContext): string | undefined {
		try {
			const id = ctx.sessionManager.getSessionId();
			return typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			return undefined;
		}
	}

	function retire(session: Session | undefined): void {
		if (!session) return;
		if (session.flushTimer) clearTimeout(session.flushTimer);
		if (session.waitTimer) clearInterval(session.waitTimer);
		session.flushTimer = undefined;
		session.waitTimer = undefined;
		session.pending = undefined;
	}

	/** The session for this ctx, swapping out a replaced one. */
	function sessionFor(ctx: ExtensionContext): Session | undefined {
		if (!interactive(ctx)) return undefined;
		const id = sessionId(ctx);
		if (!id) return undefined;
		if (current?.id === id) return current;
		retire(current);
		current = {
			id,
			cwd: ctx.cwd ?? "",
			title: firstPrompt(ctx),
			chain: Promise.resolve(),
			lastSentAt: 0,
			prompts: 0,
		};
		return current;
	}

	function dispatch(session: Session, update: Update): void {
		session.lastSentAt = Date.now();
		session.chain = session.chain.then(() => post(session, update)).catch(() => {});
	}

	function stopWaiting(session: Session): void {
		if (session.waitTimer) clearInterval(session.waitTimer);
		session.waitTimer = undefined;
		session.waitingSince = undefined;
	}

	/** Attention and lifecycle states: sent now, superseding anything queued. */
	function urgent(session: Session, update: Update): void {
		if (session.flushTimer) clearTimeout(session.flushTimer);
		session.flushTimer = undefined;
		session.pending = undefined;
		stopWaiting(session);
		dispatch(session, update);
	}

	/** Tool progress: at most one per COALESCE_MS, the latest one wins. */
	function throttled(session: Session, update: Update): void {
		stopWaiting(session);
		const wait = session.lastSentAt + COALESCE_MS - Date.now();
		if (wait <= 0 && !session.flushTimer) {
			dispatch(session, update);
			return;
		}
		session.pending = update;
		if (session.flushTimer) return;
		session.flushTimer = setTimeout(() => {
			session.flushTimer = undefined;
			const pending = session.pending;
			session.pending = undefined;
			if (pending && current === session) dispatch(session, pending);
		}, Math.max(0, wait));
		session.flushTimer.unref?.();
	}

	function waiting(session: Session, text: string): void {
		const id = `${session.id}:prompt:${++session.prompts}`;
		const base: Update = {
			state: "waiting",
			text,
			busy: false,
			status: "needs_input",
			messageKind: "prompt",
			eventKind: "approval-request",
			requestId: id,
		};
		urgent(session, base);
		session.prompt = { id, text };
		const since = Date.now();
		session.waitingSince = since;
		session.waitTimer = setInterval(() => {
			if (current !== session || session.waitingSince !== since) {
				stopWaiting(session);
				return;
			}
			// Distinct text per beat, or the server suppresses it as a duplicate
			// without refreshing the card's place in the eviction order.
			dispatch(session, { ...base, text: `${text} · ${elapsed(Date.now() - since)}` });
		}, WAITING_HEARTBEAT_MS);
		session.waitTimer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		urgent(session, {
			state: "jumping",
			duration: 1200,
			busy: false,
			status: "running",
			eventKind: "session-start",
		});
	});

	pi.on("input", (event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		const prompt = typeof event?.text === "string" ? clip(event.text, 60) : "";
		if (prompt && !session.title) session.title = prompt;
		urgent(session, {
			state: "jumping",
			duration: 900,
			text: "Thinking…",
			busy: true,
			status: "running",
			messageKind: "status",
			eventKind: "user-prompt",
		});
	});

	pi.on("tool_call", (event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		const name = event?.toolName ?? "";
		throttled(session, {
			state: REVIEW_TOOLS.has(name) ? "review" : "running",
			text: describeTool(name, (event?.input ?? {}) as Record<string, unknown>, session.cwd, false),
			busy: true,
			status: "running",
			messageKind: "tool",
			eventKind: "tool-progress",
		});
	});

	pi.on("tool_result", (event, ctx) => {
		// Success posts nothing: the next tool_call or agent_settled supersedes it
		// within moments, and every post spends the shared 30/s budget.
		if (!event?.isError) return;
		const session = sessionFor(ctx);
		if (!session) return;
		urgent(session, {
			state: "failed",
			duration: 2500,
			text: `${describeTool(event.toolName ?? "", (event.input ?? {}) as Record<string, unknown>, session.cwd, true)} failed`,
			busy: true,
			status: "running",
			messageKind: "tool",
			eventKind: "tool-failure",
		});
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		const title = typeof event?.title === "string" ? clip(event.title, 40) : "";
		waiting(session, title ? `Waiting: ${title}` : "Waiting on you");
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		const prompt = session.prompt;
		session.prompt = undefined;
		urgent(session, {
			state: "running",
			text: "Continuing…",
			busy: true,
			status: "running",
			messageKind: "status",
			eventKind: "approval-resolved",
			resolvesRequestId: prompt?.id,
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		urgent(session, {
			state: "waving",
			duration: 1500,
			text: "Done.",
			busy: false,
			status: "completed",
			messageKind: "lifecycle",
			eventKind: "session-end",
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const session = sessionFor(ctx);
		if (!session) return;
		urgent(session, { state: "idle", busy: false, status: "idle", eventKind: "session-shutdown" });
		retire(session);
		if (current === session) current = undefined;
	});

	pi.registerCommand("petdex", {
		description: "Show whether the Petdex desktop pet is connected",
		handler: async (_args, ctx) => {
			if (existsSync(KILLSWITCH_PATH)) {
				ctx.ui.notify(`Petdex hooks are disabled (${KILLSWITCH_PATH} exists).`, "warning");
				return;
			}
			const token = await readToken();
			ctx.ui.notify(
				token ? "Petdex is connected." : "Petdex Desktop is not running (no hook token).",
				token ? "info" : "warning",
			);
		},
	});
}
