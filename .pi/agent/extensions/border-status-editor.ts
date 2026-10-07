import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Published by next-prompt.ts; duplicated rather than imported so neither extension loads the other.
const SUGGESTION_CHANNEL = "next-prompt:suggestion";
// The fake cursor Editor draws at the end of an empty line; ghost text goes right after it.
const EMPTY_CURSOR = "\x1b[7m \x1b[0m";

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow || !usage || usage.percent === null) {
		return "ctx ?";
	}
	return `ctx ${Math.round(usage.percent)}%/${(contextWindow / 1000).toFixed(0)}k`;
}

function formatThinking(level: string): string {
	return level === "off" ? "off" : level;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	let isWorking = false;
	let workStart = 0;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let sessionGeneration = 0;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let suggestion: string | null = null;

	pi.events.on(SUGGESTION_CHANNEL, (data) => {
		const text = (data as { text?: unknown } | undefined)?.text;
		suggestion = typeof text === "string" && text ? text : null;
		activeTui?.requestRender();
	});

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	pi.on("agent_start", () => {
		isWorking = true;
		workStart = Date.now();
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		stopSpinner();
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());

		// ctx is invalidated on session replacement and every getter on it throws
		// once stale. pi.on() has no unsubscribe, so the agent_end handler below
		// outlives its session: gate deferred work on this session still being the
		// current one, and read cwd eagerly while ctx is known good.
		const generation = ++sessionGeneration;
		const sessionCwd = ctx.cwd;
		const isCurrent = () => generation === sessionGeneration;

		let branch: string | undefined;
		let dirty = false;

		const refreshBranch = async () => {
			if (!isCurrent()) return;
			try {
				const result = await pi
					.exec("git", ["branch", "--show-current"], { cwd: sessionCwd })
					.catch(() => undefined);
				if (!isCurrent()) return;
				const stdout = result?.stdout.trim();
				branch = stdout && stdout.length > 0 ? stdout : undefined;
				const status = await pi
					.exec("git", ["status", "--porcelain"], { cwd: sessionCwd })
					.catch(() => undefined);
				if (!isCurrent()) return;
				dirty = (status?.stdout.trim().length ?? 0) > 0;
				activeTui?.requestRender();
			} catch {
				// a background refresh must never reject into an unhandled crash
			}
		};
		void refreshBranch();
		pi.on("agent_end", () => void refreshBranch());

		class BorderStatusEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 2 });
				activeTui = tui;
			}

			/** Ghost text shows only in an empty editor with no autocomplete open, so Tab/→ have nothing else to do. */
			private ghost(): string | null {
				if (!suggestion || !isCurrent() || this.getText() !== "" || this.isShowingAutocomplete()) return null;
				return suggestion;
			}

			handleInput(data: string): void {
				const ghost = this.ghost();
				if (ghost && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
					suggestion = null;
					this.setText(ghost);
					activeTui?.requestRender();
					return;
				}
				super.handleInput(data);
			}

			private withGhost(line: string, ghost: string, width: number): string {
				const at = line.indexOf(EMPTY_CURSOR);
				if (at === -1) return line;
				const prefix = line.slice(0, at + EMPTY_CURSOR.length);
				const room = width - visibleWidth(prefix) - 1;
				if (room < 4) return line;
				const text = ctx.ui.theme.fg("dim", truncateToWidth(ghost, room, "…"));
				const body = prefix + text;
				return body + " ".repeat(Math.max(0, width - visibleWidth(body)));
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;
				if (!isCurrent()) return lines;

				try {
					const thm = ctx.ui.theme;
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const thinking = pi.getThinkingLevel();
					const topLeft = isWorking
						? thm.fg("accent", ` ${spinnerFrames[spinnerIndex]} ${formatElapsed(Date.now() - workStart)} `)
						: "";
					const topRight = "";
					const bottomLeft = thm.fg("accent", ` ${model} · ${formatThinking(thinking)} `);
					const bottomRight = thm.fg(
						"text",
						` ${formatContext(ctx)} · ${formatCwd(sessionCwd)}${branch ? ` (${branch}${dirty ? " ●" : ""})` : ""} `,
					);
					const borderColor = (text: string) => this.borderColor(text);

					const top = fitBorder(topLeft, topRight, width, borderColor);
					const bottom = fitBorder(bottomLeft, bottomRight, width, borderColor);
					// Autocomplete rows are appended after the bottom border; keep them below ours.
					const acHeight = ((this as any).renderedAutocompleteHeight as number | undefined) ?? 0;
					const borderIndex = lines.length - 1 - acHeight;
					const content = lines.slice(1, borderIndex);
					const ghost = this.ghost();
					if (ghost && content.length > 0) content[0] = this.withGhost(content[0], ghost, width);
					const autocomplete = lines.slice(borderIndex + 1);
					return [top, "", ...content, "", bottom, ...autocomplete];
				} catch {
					return lines;
				}
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BorderStatusEditor(tui, theme, keybindings));
	});
}
