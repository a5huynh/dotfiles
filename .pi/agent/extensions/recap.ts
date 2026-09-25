/**
 * recap — idle-triggered conversation recap card.
 *
 * After N idle minutes, summarizes the current session branch with one LLM call
 * and shows the result as a dimmed, height-capped card — by default a widget
 * above the editor that can be opened and closed.
 *
 * Vendored from @nicknisi/pi-recap v0.1.6 rather than installed via `packages`,
 * so we can edit it locally. Tradeoff: upstream fixes must be merged by hand.
 *   upstream: https://github.com/nicknisi/pi-extensions/tree/main/packages/recap
 *   provenance: npm tarball 0.1.6 and GitHub main verified byte-identical.
 *
 * Surfaces:
 *   - widget               — the card above the editor; ctrl+shift+r toggles it
 *   - `/recap`             — generate a recap now (and open it)
 *   - `/recap show|hide|toggle|clear` — drive the widget without an LLM call
 *   - `/recap-idle <min>`  — set the idle threshold (persisted)
 *
 * Config: ~/.pi/agent/configs/recap.json (untracked; `/recap-idle` writes it)
 *   { "idleMinutes": 3, "surface": "widget",
 *     "model": { "provider": "anthropic", "id": "claude-haiku-4-5" } }
 *   The model override matters: unset, recap uses the *session* model, which for
 *   us is claude-opus-5 at max thinking.
 *
 * Local changes from upstream:
 *   - The card is a *widget* above the editor by default rather than a transcript
 *     entry, and it opens and closes (ctrl+shift+r, or `/recap show|hide|toggle`).
 *     Upstream only ever appended a session entry, which scrolls away with the
 *     conversation exactly when you want to glance back at it. The tradeoff is
 *     that a widget is in-memory only — `setWidget` state does not survive a
 *     resume — and it costs editor rows while open, which is why MAX_WIDGET_LINES
 *     is 6 against the transcript's 10, and why a closed card collapses to one
 *     dim line instead of vanishing: otherwise nothing tells you a recap exists.
 *     `surface` in the config takes the old behaviour back ("transcript") or runs
 *     both. The prompt's line budget follows the active surface, so a widget-only
 *     setup asks for 6 lines rather than paying for 10 and then cutting 4.
 *   - The widget is clickable (MouseRegion), but only in `--tui-mode fullscreen`:
 *     regular mode never captures mouse input at all, because the terminal owns
 *     its scrollback, so the click is silently inert there. That is why
 *     ctrl+shift+r exists and why the closed line advertises the *key*: a hint
 *     that says "click me" would be a lie in pi's default mode. A closed card
 *     toggles from anywhere; an open one only from its header rule, so clicking
 *     into the body (or dragging to select it) does not collapse what you are
 *     reading. Only `click` is claimed, so drag-selection still reaches the TUI.
 *   - The pi-side 10-line widget cap applies to the `string[]` form of setWidget
 *     only, not the component factory this uses; MAX_WIDGET_LINES is ours alone.
 *   - The toggle is deferred to a microtask: the click handler runs from inside
 *     the very component tree `setWidget` is about to tear down and replace.
 *   - The card is built by one `buildCard`, used by both the entry renderer and
 *     the widget factory, so the two surfaces cannot drift apart visually.
 *   - `latest` is dropped on session_start. A recap describes one conversation
 *     branch, and a widget carried into a replaced session would describe the
 *     wrong one; there is nothing to restore on resume either, by definition.
 *   - The idle timer fires against the newest ctx any handler has seen, not the
 *     one captured at session_start: every getter on a ctx throws once its
 *     session is replaced, and a 30s interval outlives the session it started in.
 *   - No recap is generated while the agent is working, on any path. Upstream
 *     checked isIdle only on the idle timer, and only *before* the LLM call, so
 *     `/recap` and ctrl+shift+r ran mid-turn, and a prompt sent during the few
 *     seconds of generation still got a recap dropped on top of the new run (a
 *     transcript entry written mid-turn, with surface "transcript"). A run now
 *     bumps `runEpoch` and aborts the in-flight call, and the result is
 *     discarded if the epoch moved. Toggling an *existing* card stays allowed.
 *   - MAX_CARD_LINES 5 -> 10, and the prompt's line budget now derives from that
 *     constant. Upstream asked the model for "6-8 lines" then capped at 5, so a
 *     well-behaved summary was always truncated. One constant now, so the two
 *     cannot drift apart again.
 *   - capLines counts only non-blank lines. Markdown puts a blank line between
 *     blocks, so blank lines were eating the budget: a 5-line cap rendered as
 *     heading / blank / one point / blank / truncated, i.e. ~2 lines of content.
 *   - The recap ends with a "Next steps" section, and it is budgeted and capped
 *     *separately* (NEXT_STEPS_LINES on top of the body budget) rather than
 *     sharing one cap. capLines truncates from the end and next steps are by
 *     definition last, so a single budget would drop the most actionable part of
 *     the card first, and only on the dense recaps where it matters most. The
 *     section is omitted entirely when nothing is pending — a permanent "nothing
 *     to do" stub would cost a line of a 6-line card every time — which is also
 *     why a heading the model emits with no items under it is dropped rather
 *     than rendered as a dangling header.
 *   - MAX_WIDGET_LINES stays 6 for the *body*, so the open card grew by the
 *     next-steps block. That is affordable only because the card collapses:
 *     ctrl+shift+r gives the rows back without losing the recap.
 *   - The section is split off by heading text, taking the *last* match, so a
 *     "next steps" heading the model repeats cannot swallow the body behind it.
 *   - Prompt forbids a title, and stripTitle drops one if the model emits it
 *     anyway. The card already renders a bold "Recap · <time>" header, so a
 *     model-authored "Recap" heading both duplicated it and cost a line.
 *   - The "Recap · <time>" header is inlined into the top rule (TitledRule)
 *     rather than occupying its own line, which is one line back on a 10-line
 *     budget. DynamicBorder cannot do this — it takes only a colour function
 *     and fills the whole width — so the top rule is a small local component.
 *   - Rules above and below the card, and Box paddingY 0 -> 1. Both rules are
 *     tinted with the card background so the whole thing reads as one block.
 *     DynamicBorder is given an explicit colour fn on purpose: its docstring
 *     warns that the module-global `theme` can be undefined in extensions,
 *     because jiti loads them with a separate module cache. The renderer's own
 *     `theme` argument is a real instance, so it is the safe source.
 *
 * Tests: `node .pi/agent/extensions/recap.test.mjs` runs the whole extension
 * offline against a faked host and a stubbed provider — the card's own rendered
 * lines are assertable, which is what covers the open/closed states and the caps.
 *
 * Card background: `buildCard` uses theme.bg('customMessageBg'), which is
 * the only knob available — theme.bg() accepts just 8 named tokens, none of them
 * editor/card specific. In tokyo-night.json that token was `bgDark` (#16161e),
 * i.e. *darker* than the #1a1b26 base, so the card receded instead of standing
 * out. Retinted there to a `bgFloat` var (#1f2335). Nothing else in this setup
 * uses customMessageBg, so that retint is effectively recap-only — but it would
 * also affect any future hook-injected custom messages.
 */
import { uuidv7 } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai/compat';
import {
  DynamicBorder,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Box,
  type Component,
  Container,
  Markdown,
  MouseRegion,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Auto-recap: after N idle minutes, surface a dimmed recap card — as a widget
// above the editor, a transcript entry, or both, per `surface` in the config.

/** Where a generated recap is shown. Widget is transient; transcript persists. */
type Surface = 'widget' | 'transcript' | 'both';
const SURFACES: Surface[] = ['widget', 'transcript', 'both'];

type Config = { idleMinutes: number; surface: Surface; model?: { provider: string; id: string } };

const DEFAULT_CONFIG: Config = { idleMinutes: 3, surface: 'widget' };
// Resolved per call, not at module load: `getAgentDir()` honours the agent-dir
// env var, so hardcoding ~/.pi/agent would read (and write) the wrong file for
// anyone running a non-default agent dir. Per-call also means a config written
// by `saveConfig` is visible to the next read.
function configPath(): string {
  return path.join(getAgentDir(), 'configs', 'recap.json');
}
const ENTRY_TYPE = 'recap';
const WIDGET_KEY = 'recap';
const TOGGLE_KEY = 'ctrl+shift+r';
const TICK_MS = 30_000;
const MIN_BRANCH_LEN = 4;
const MAX_CARD_LINES = 10;
// Transcript space is free; editor space is not. A widget this tall already
// pushes the editor down a third of a small terminal.
const MAX_WIDGET_LINES = 6;
// The "Next steps" block, budgeted on top of the body caps above: a heading
// plus NEXT_STEPS_ACTIONS bullets. Separate from the body budget on purpose —
// see the header note; a shared cap truncates exactly this section away.
const NEXT_STEPS_LINES = 3;
const NEXT_STEPS_ACTIONS = NEXT_STEPS_LINES - 1;
// Matches `## Next steps`, `**Next steps**`, `Next Steps:`, etc. — the same
// latitude stripTitle allows, since the model's heading style is not fixed.
const NEXT_STEPS_HEADING = /^(#{1,6}\s*)?\*{0,2}next\s+steps\*{0,2}\s*:?\s*$/i;

let lastActivity = Date.now();
let firedThisIdle = false;
let timer: ReturnType<typeof setInterval> | null = null;
let piRef: ExtensionAPI | null = null;
let lastModel: ExtensionContext['model'] = undefined;
/** The recap the widget is showing, if any. In-memory: a widget has no storage. */
let latest: { summary: string; ts: number } | null = null;
let widgetOpen = false;
/**
 * Newest ctx handed to a handler. The idle timer must not use the ctx captured
 * at session_start — pi invalidates it on session replacement and every getter
 * on the stale object throws, while the interval keeps ticking.
 */
let ctxRef: ExtensionContext | null = null;
/**
 * Bumped whenever an agent run starts or the session is replaced. A recap takes
 * seconds to generate; one whose epoch moved underneath it describes a
 * conversation that has since moved on and must be dropped, not shown mid-turn.
 */
let runEpoch = 0;
/** The in-flight summary call, aborted when a run starts so it stops spending tokens. */
let inflight: AbortController | null = null;

function readConfig(): Config {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      idleMinutes: typeof parsed.idleMinutes === 'number' ? parsed.idleMinutes : DEFAULT_CONFIG.idleMinutes,
      // Validated against the known set: an unknown string would otherwise
      // disable both surfaces and the extension would silently do nothing.
      surface: SURFACES.includes(parsed.surface) ? parsed.surface : DEFAULT_CONFIG.surface,
      model: parsed.model && typeof parsed.model === 'object' ? parsed.model : undefined,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(c: Config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

type Entry = { type: string; message?: { role?: string; content?: unknown } };
type Block = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is Block => !!p && typeof p === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
}

function toolLines(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is Block => !!p && typeof p === 'object')
    .filter((b) => b.type === 'toolCall' && typeof b.name === 'string')
    .map((b) => `Tool ${b.name} called with ${JSON.stringify(b.arguments ?? {})}`);
}

function buildConversation(entries: Entry[]): string {
  const sections: string[] = [];
  for (const e of entries) {
    if (e.type !== 'message' || !e.message?.role) continue;
    const role = e.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const lines: string[] = [];
    const tp = textParts(e.message.content);
    const t = tp.join('\n').trim();
    if (t) lines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${t}`);
    if (role === 'assistant') lines.push(...toolLines(e.message.content));
    if (lines.length) sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * Ask for what the active surface can actually show. Widget-only means 6 lines,
 * so requesting 10 would spend tokens on text `capLines` then throws away.
 * "both" takes the larger budget — the transcript copy is the uncut one.
 * This is the *body* budget; the next-steps block is allowed on top of it.
 */
function lineBudget(cfg: Config): number {
  return cfg.surface === 'widget' ? MAX_WIDGET_LINES : MAX_CARD_LINES;
}

function summaryPrompt(conversation: string, budget: number): string {
  return [
    'Summarize this conversation so far as a concise recap.',
    'Include goals, key decisions, progress, and open items.',
    `Be terse — at most ${budget} lines. Use short markdown headings.`,
    'Do not add a title or top-level heading; the card is already labelled "Recap".',
    'Skip preamble; lead with the substance.',
    '',
    `Then end with a "Next steps" heading followed by at most ${NEXT_STEPS_ACTIONS} bullets naming the`,
    'next concrete actions, as imperatives ("Run the tests", not "The tests could be run").',
    'These lines are extra — they do not count against the limit above.',
    'If nothing is genuinely pending, omit the section entirely rather than inventing filler.',
    '',
    '<conversation>',
    conversation,
    '</conversation>',
  ].join('\n');
}

/**
 * Split a trailing "Next steps" section off the body. The *last* heading wins,
 * so a model that repeats it cannot leave the body stranded inside the tail.
 * A heading with no content under it yields no tail at all — the card must not
 * show a dangling header when the model announces a section and then omits it.
 */
function splitNextSteps(text: string): { body: string; next: string } {
  const lines = text.split('\n');
  const at = lines.reduce((found, line, i) => (NEXT_STEPS_HEADING.test(line.trim()) ? i : found), -1);
  if (at === -1) return { body: text, next: '' };
  const next = lines.slice(at);
  if (!next.slice(1).some((line) => line.trim())) return { body: lines.slice(0, at).join('\n'), next: '' };
  return { body: lines.slice(0, at).join('\n'), next: next.join('\n') };
}

/**
 * Cap body and next steps against their own budgets, so a verbose body cannot
 * consume the section that says what to do next.
 */
function capCard(text: string, bodyMax: number, nextMax: number): string {
  const { body, next } = splitNextSteps(text);
  const capped = capLines(body, bodyMax);
  if (!next) return capped;
  return `${capped}\n\n${capLines(next, nextMax)}`;
}

// Only non-blank lines count toward `max`. Markdown separates blocks with blank
// lines, so counting them spent the budget on structure rather than content.
function capLines(text: string, max: number): string {
  const out: string[] = [];
  let kept = 0;
  for (const line of text.split('\n')) {
    if (line.trim()) {
      if (kept === max) return out.join('\n').trimEnd() + ' …';
      kept++;
    }
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

// Leading '─' run before the label on the top rule.
const RULE_LEAD = 2;

// A horizontal rule with the title inlined, so the header costs no extra line:
//   ── Recap · 4:49:05 PM ────────────────────────────────────────────
// The label carries ANSI (dim + bold), so the fill is measured with
// visibleWidth; .length would count escape bytes and truncate the rule.
class TitledRule implements Component {
  constructor(
    private readonly label: string,
    private readonly glyph: (s: string) => string,
    private readonly bg: (s: string) => string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const text = ` ${this.label} `;
    const textWidth = visibleWidth(text);
    // Too narrow for the label: degrade to a plain rule rather than overflow
    // the line, which would push the card wider than the viewport.
    if (textWidth + RULE_LEAD + 1 > width) {
      return [this.bg(this.glyph('─'.repeat(Math.max(1, width))))];
    }
    const tail = width - RULE_LEAD - textWidth;
    return [this.bg(this.glyph('─'.repeat(RULE_LEAD)) + text + this.glyph('─'.repeat(tail)))];
  }
}

// The card renders its own bold "Recap · <time>" header, so a model-emitted
// title duplicates it and costs a line. The prompt says not to; this enforces it
// for the times the model does it anyway. Matches `# Recap`, `**Recap**`, etc.
function stripTitle(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^(#{1,6}\s*)?\*{0,2}recap\*{0,2}\s*:?\s*$/i.test(lines[i].trim())) {
    lines.splice(0, i + 1);
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join('\n');
  }
  return text;
}

// The card itself, shared by the transcript renderer and the widget factory so
// the two surfaces cannot drift apart. Only the line budget differs.
function buildCard(summary: string, ts: number, theme: Theme, maxLines: number): Container {
  const dim = (s: string) => theme.fg('dim', s);
  // Theme-aware bg: same token pi's own summary cards (compaction, branch)
  // use, so the card stands out appropriately in every theme.
  const bg = (s: string) => theme.bg('customMessageBg', s);
  // Tinted so the rules join the card into one block instead of floating
  // on the terminal background. Box paddingY=1 adds a bg-filled blank line
  // inside each rule, so the text is not jammed against them.
  const glyph = (s: string) => theme.fg('borderMuted', s);
  const label = dim(theme.bold('Recap')) + dim(` · ${new Date(ts).toLocaleTimeString()}`);
  const box = new Box(1, 1, (s) => bg(dim(s)));
  box.addChild(new Markdown(capCard(stripTitle(summary), maxLines, NEXT_STEPS_LINES), 0, 0, getMarkdownTheme()));

  const card = new Container();
  card.addChild(new TitledRule(label, glyph, bg));
  card.addChild(box);
  card.addChild(new DynamicBorder((s) => bg(glyph(s))));
  return card;
}

// A closed card collapses to this rather than disappearing: a widget holds the
// only copy of the recap, so removing it outright would leave no sign one exists.
class CollapsedCard implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, width)];
  }
}

/**
 * Make a widget toggle on a left click. `rows: 'header'` limits the hit area to
 * the first line, which is the card's title rule.
 *
 * The click is dispatched from inside the component `setWidgetOpen` immediately
 * replaces, so the state change is deferred one microtask rather than mutating
 * the tree mid-dispatch. `ctxRef` rather than a captured ctx for the usual
 * reason: a widget outlives the handler that built it.
 */
function clickToToggle(child: Component, rows: 'header' | 'all'): Component {
  return new MouseRegion(child, (event) => {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (rows === 'header' && event.y !== 0) return undefined;
    const live = ctxRef;
    if (!live) return undefined;
    queueMicrotask(() => {
      const now = ctxRef;
      if (now) setWidgetOpen(now, 'toggle');
    });
    return { handled: true, render: true };
  });
}

/** Push `latest` into the widget slot in whatever state the toggle is in. */
function refreshWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== 'tui') return;

  if (!latest || readConfig().surface === 'transcript') {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const { summary, ts } = latest;
  const factory: (tui: TUI, theme: Theme) => Component = widgetOpen
    ? (_tui, theme) => clickToToggle(buildCard(summary, ts, theme, MAX_WIDGET_LINES), 'header')
    : (_tui, theme) =>
        clickToToggle(
          new CollapsedCard(theme.fg('dim', `▸ Recap · ${new Date(ts).toLocaleTimeString()} · ${TOGGLE_KEY} to open`)),
          'all',
        );

  ctx.ui.setWidget(WIDGET_KEY, factory, { placement: 'aboveEditor' });
}

/** Open, close, or flip the widget. Returns false when there is nothing to show. */
function setWidgetOpen(ctx: ExtensionContext, next: boolean | 'toggle'): boolean {
  if (!latest) return false;
  widgetOpen = next === 'toggle' ? !widgetOpen : next;
  refreshWidget(ctx);
  return true;
}

async function generateSummary(ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
  const cfg = readConfig();
  const configuredModel =
    cfg.model && typeof cfg.model.provider === 'string' && typeof cfg.model.id === 'string'
      ? ctx.modelRegistry.find(cfg.model.provider, cfg.model.id)
      : undefined;
  const model = configuredModel ?? ctx.model ?? lastModel;
  if (!model) {
    ctx.ui.notify('recap: no model available', 'warning');
    return '';
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok) {
    ctx.ui.notify(`recap: ${auth.error ?? 'no API key for model'}`, 'warning');
    return '';
  }
  const conversation = buildConversation(ctx.sessionManager.getBranch());
  if (!conversation.trim()) return '';
  const response = await complete(
    model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: summaryPrompt(conversation, lineBudget(cfg)) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      // Spread conditionally: optional in ProviderStreamOptions, and
      // exactOptionalPropertyTypes rejects an explicit undefined.
      ...(auth.apiKey !== undefined && { apiKey: auth.apiKey }),
      ...(auth.headers !== undefined && { headers: auth.headers }),
      ...(auth.env !== undefined && { env: auth.env }),
      signal,
      reasoningEffort: 'low',
      cacheRetention: 'none',
      sessionId: uuidv7(),
    },
  );
  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Generate and surface a recap, but never while the agent is working. That is
 * checked twice: before the call, and again after it, since a run can start
 * during the seconds the summary takes. `manual` says whether someone asked
 * (and so deserves to hear why nothing appeared) or the idle timer fired.
 */
async function injectRecap(ctx: ExtensionContext, manual: boolean) {
  if (!ctx.isIdle()) {
    if (manual) ctx.ui.notify('recap: agent is working, try again once it settles', 'info');
    return;
  }
  if (manual) ctx.ui.notify('Generating recap...', 'info');

  const epoch = runEpoch;
  const controller = new AbortController();
  inflight?.abort();
  inflight = controller;
  let summary: string;
  try {
    summary = await generateSummary(ctx, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) summary = '';
    else throw error;
  } finally {
    if (inflight === controller) inflight = null;
  }

  // Epoch first: if the session was replaced, `ctx` is stale and isIdle throws.
  // A moved epoch is also silent: the ctx may be unsafe, and the user has
  // just sent a prompt, so nothing is lost by not announcing the drop.
  if (epoch !== runEpoch || controller.signal.aborted) return;
  if (!ctx.isIdle()) {
    if (manual) ctx.ui.notify('recap: discarded, agent is busy', 'info');
    return;
  }
  if (!summary) return;
  const ts = Date.now();
  const surface = readConfig().surface;

  if (surface !== 'widget') piRef?.appendEntry(ENTRY_TYPE, { summary, ts });
  if (surface !== 'transcript') {
    latest = { summary, ts };
    // A fresh recap opens itself — an idle-fired card nobody can see is the
    // whole feature failing quietly.
    widgetOpen = true;
    refreshWidget(ctx);
  }
}

async function maybeFire(ctx: ExtensionContext) {
  if (!ctx.isIdle() || firedThisIdle) return;
  const cfg = readConfig();
  if (Date.now() - lastActivity < cfg.idleMinutes * 60_000) return;
  if (ctx.sessionManager.getBranch().length < MIN_BRANCH_LEN) return;
  firedThisIdle = true;
  await injectRecap(ctx, false);
}

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.on('session_start', async (_e, ctx) => {
    // Before the mode gate: a recap in flight for the old session must be
    // dropped whatever mode the new one runs in.
    runEpoch++;
    inflight?.abort();
    if (ctx.mode !== 'tui') return;
    ctxRef = ctx;
    lastActivity = Date.now();
    firedThisIdle = false;
    // A recap describes one branch. On a replaced session the widget would be
    // showing the previous conversation's summary, and there is nothing to
    // restore on a resume either — a widget has no storage.
    latest = null;
    widgetOpen = false;
    ctx.ui.setWidget(WIDGET_KEY, undefined);

    pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
      const data = entry.data as { summary: string; ts: number };
      return buildCard(data.summary, data.ts, theme, MAX_CARD_LINES);
    });

    // A session replaced without a shutdown would otherwise leak the previous
    // interval, which keeps ticking against a ctx nobody can use.
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      const live = ctxRef;
      if (live) void maybeFire(live);
    }, TICK_MS);
    timer.unref?.();
  });

  pi.on('before_agent_start', async (_e, ctx) => {
    runEpoch++;
    inflight?.abort();
    ctxRef = ctx;
    lastActivity = Date.now();
    firedThisIdle = false;
    lastModel = ctx.model ?? lastModel;
  });

  pi.on('agent_settled', async (_e, ctx) => {
    ctxRef = ctx;
    lastActivity = Date.now();
    lastModel = ctx.model ?? lastModel;
  });

  pi.on('session_shutdown', async (_e, ctx) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    ctxRef = null;
    void ctx;
  });

  pi.registerShortcut(TOGGLE_KEY, {
    description: 'Open/close the recap card',
    handler: async (ctx) => {
      if (setWidgetOpen(ctx, 'toggle')) return;
      // Nothing generated yet: the natural reading of "open the recap" is to
      // make one rather than report that there is none.
      await injectRecap(ctx, true);
    },
  });

  pi.registerCommand('recap', {
    description: 'Generate a conversation recap (args: show | hide | toggle | clear)',
    getArgumentCompletions: (prefix) =>
      ['show', 'hide', 'toggle', 'clear'].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),

    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === 'clear') {
        latest = null;
        widgetOpen = false;
        refreshWidget(ctx);
        ctx.ui.notify('recap cleared', 'info');
        return;
      }

      if (arg === 'show' || arg === 'hide' || arg === 'toggle') {
        if (readConfig().surface === 'transcript') {
          ctx.ui.notify('recap surface is "transcript" — set "widget" or "both" in recap.json', 'warning');
          return;
        }
        if (setWidgetOpen(ctx, arg === 'toggle' ? 'toggle' : arg === 'show')) return;
        if (arg === 'hide') return;
      } else if (arg) {
        ctx.ui.notify('usage: /recap [show | hide | toggle | clear]', 'warning');
        return;
      }

      await injectRecap(ctx, true);
    },
  });

  pi.registerCommand('recap-idle', {
    description: 'Set recap idle threshold in minutes',
    handler: async (args, ctx) => {
      const n = Number(args.trim());
      if (!Number.isFinite(n) || n <= 0) {
        ctx.ui.notify('usage: /recap-idle <minutes>', 'warning');
        return;
      }
      writeConfig({ ...readConfig(), idleMinutes: n });
      ctx.ui.notify(`recap idle → ${n}m`, 'info');
    },
  });
}
