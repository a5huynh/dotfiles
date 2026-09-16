/**
 * session-title — put the session's *task* in the terminal title, so herdr's
 * sidebar and tab picker can say what a pi pane is actually doing.
 *
 * herdr reads every pane's terminal title into `terminal_title_stripped`, and
 * both `[ui.sidebar.agents.rows_by_agent]` and plugins/tab-jump/jump.sh render
 * it. Claude reports its task there ("Review pull request #871"); pi reports
 * `π - <dirname>`, which only restates the workspace the row already names — so
 * a pi row costs a line and carries nothing. This fills that field in.
 *
 * Label precedence:
 *   1. an explicit session name (`/name`) — pi already renders it, so we do
 *      nothing at all and let pi own the title
 *   2. the session's first user prompt, normalized and truncated
 *
 * The *first* prompt rather than the latest: it identifies the pane for its
 * whole life, which is what you need when scanning 20 of them, and it does not
 * churn the sidebar on every turn. `PI_SESSION_TITLE=last` tracks the most
 * recent prompt instead; `off` disables the extension.
 *
 * Bare label, no `π - ` prefix and no cwd: the sidebar row and the picker
 * already print workspace and tab beside it, and jump.sh clips this field to 46
 * columns, so a prefix is pure overhead. That is also exactly the shape Claude
 * emits, which is the shape the sidebar was tuned for. Gated on HERDR_ENV so
 * that outside herdr — where the OS window title has no other "which agent is
 * this" marker — pi's own `π - <dirname>` is left alone.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

/** jump.sh clips the title column to 46; stay just under so it rarely re-clips. */
const MAX_LABEL_WIDTH = 44;

/**
 * pi calls its own `updateTerminalTitle()` *after* extensions bind (see
 * `rebindCurrentSession`), so a title set during `session_start` is immediately
 * overwritten. Re-assert once the bind has settled. Overridable so the offline
 * test does not have to sleep through it.
 */
const REASSERT_DELAY_MS = (() => {
	const raw = Number.parseInt(process.env.PI_SESSION_TITLE_DELAY_MS ?? "", 10);
	return Number.isFinite(raw) && raw >= 0 ? raw : 500;
})();

type Source = "first" | "last";

function enabled(): boolean {
	return process.env.HERDR_ENV === "1" && process.env.PI_SESSION_TITLE !== "off";
}

function source(): Source {
	return process.env.PI_SESSION_TITLE === "last" ? "last" : "first";
}

// ---------------------------------------------------------------- label ----

/**
 * Flatten a user message's content to plain text. `content` is either a string
 * or a parts array that may carry images, which have no text to contribute.
 */
function messageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part) => (part as { type?: string })?.type === "text")
		.map((part) => String((part as { text?: unknown }).text ?? ""))
		.join(" ");
}

/**
 * Collapse a prompt into one title-safe line.
 *
 * Stripping C0/C1 controls is load-bearing rather than cosmetic: this string is
 * written to the terminal inside an OSC sequence, which a BEL (`\x07`) or an ST
 * (`\x1b\\`) in the prompt would terminate early, dumping the remainder of the
 * prompt into the shell as literal text. Prompts routinely contain pasted
 * terminal output, so this is reachable, not theoretical.
 */
function normalize(text: string): string {
	const clean = text
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!clean) {
		return "";
	}
	// `truncateToWidth` measures wide characters correctly but wraps its ellipsis
	// in ANSI resets — it is built for TUI lines, not titles. Strip them back off:
	// escapes in a title would bleed into herdr, which renders labels literally and
	// whose picker wraps this field in its own color spans.
	return stripTerminalSequences(truncateToWidth(clean, MAX_LABEL_WIDTH, "…"));
}

/** Recover a label from an already-populated session, for resume and reload. */
function labelFromEntries(ctx: ExtensionContext): string | undefined {
	let entries: unknown[];
	try {
		entries = ctx.sessionManager.getEntries() ?? [];
	} catch {
		return undefined;
	}

	const texts: string[] = [];
	for (const entry of entries) {
		const record = entry as { type?: string; message?: { role?: string } };
		if (record?.type !== "message" || record.message?.role !== "user") {
			continue;
		}
		const text = normalize(messageText(record.message));
		if (!text) {
			continue;
		}
		if (source() === "first") {
			return text;
		}
		texts.push(text);
	}
	return texts[texts.length - 1];
}

// ------------------------------------------------------------ extension ----

export default function (pi: ExtensionAPI) {
	if (!enabled()) {
		return;
	}

	let label: string | undefined;
	let applied: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * `setTitle` extracted from ctx rather than ctx itself. pi invalidates ctx on
	 * session replacement and every getter on the stale object throws, so a timer
	 * must not hold one — but this function only closes over the interactive mode,
	 * which outlives the session. The generation counter drops timers whose
	 * session has already been replaced.
	 */
	let setTitle: ((title: string) => void) | undefined;
	let generation = 0;

	function apply(): void {
		if (!label || label === applied) {
			return;
		}
		try {
			setTitle?.(label);
			applied = label;
		} catch {
			// A torn-down UI is not worth surfacing; the next event re-applies.
		}
	}

	function scheduleApply(): void {
		const current = ++generation;
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			if (current === generation) {
				apply();
			}
		}, REASSERT_DELAY_MS);
		timer.unref?.();
	}

	/**
	 * TUI only. Not `hasUI`, which pi documents as true in **both** TUI and RPC
	 * modes — in RPC mode `setTitle` marshals the title into an
	 * `extension_ui_request` JSON line on the protocol stream, where a terminal
	 * title has no meaning and does not belong. pi's own guidance is to gate
	 * terminal-only UI on `mode`, and herdr's integration moved this same check
	 * from `hasUI` to `mode` in v8 for exactly this reason.
	 */
	function interactive(ctx: ExtensionContext | undefined): boolean {
		return ctx?.mode === "tui";
	}

	/** An explicit session name wins: pi renders it itself, so stand down. */
	function named(ctx: ExtensionContext): boolean {
		try {
			return !!ctx.sessionManager.getSessionName();
		} catch {
			return false;
		}
	}

	function bind(ctx: ExtensionContext): void {
		setTitle = ctx.ui?.setTitle ? (title: string) => ctx.ui.setTitle(title) : undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!interactive(ctx)) {
			return;
		}
		bind(ctx);
		// A replaced session is a different task; drop what the last one showed.
		label = undefined;
		applied = undefined;
		if (named(ctx)) {
			generation += 1; // cancel any pending re-assert
			return;
		}
		label = labelFromEntries(ctx);
		scheduleApply();
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (!interactive(ctx)) {
			return;
		}
		bind(ctx);
		if (event?.name) {
			// pi owns the title again; let its own update stand.
			generation += 1;
			applied = undefined;
			return;
		}
		// Name cleared — pi fell back to `π - <dirname>`, so re-assert ours.
		applied = undefined;
		scheduleApply();
	});

	pi.on("message_start", (event, ctx) => {
		if (!interactive(ctx) || named(ctx)) {
			return;
		}
		const message = event?.message as { role?: string } | undefined;
		if (message?.role !== "user") {
			return;
		}
		if (label && source() === "first") {
			return;
		}
		const text = normalize(messageText(message));
		if (!text) {
			return;
		}
		bind(ctx);
		label = text;
		// Well clear of pi's own title update, so apply immediately.
		apply();
	});
}
