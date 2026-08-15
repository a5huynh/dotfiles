---
name: hig
description: Apple Human Interface Guidelines lookup and UI review for iOS, iPadOS, macOS, watchOS, tvOS, and visionOS. Reads live HIG pages (buttons, sheets, navigation, typography, color, accessibility, layout, SF Symbols, widgets, Liquid Glass…) and renders them as markdown, filtered to one platform. Use when building or reviewing Apple-platform UI in SwiftUI or UIKit, choosing a component or navigation pattern, checking touch targets / Dynamic Type / contrast / safe areas, or when the user asks what Apple's guidelines say.
---

# Apple Human Interface Guidelines

Read the HIG straight from Apple, per platform, as markdown.

```bash
node ~/.pi/agent/skills/hig/hig.mjs show buttons
```

Under Claude Code the same file is at `~/.claude/skills/hig/hig.mjs`.

## Look it up — don't recall it

**The HIG changes faster than model memory.** Of 171 pages, **106 currently carry a change
notice**, most dated 2026-06-08. Liquid Glass rewrote guidance for buttons, materials, app icons,
scroll edges, tab bars, and toolbars — advice that predates it is not merely stale, it is
*inverted* in places. Fetch the page before asserting what Apple recommends, and quote it.

## Commands

```bash
hig.mjs search <query…>      # find pages by keyword
hig.mjs show <slug>          # print a page as markdown
hig.mjs list [section]       # all indexed pages, grouped
hig.mjs updated [--since D]  # pages whose guidance recently changed
hig.mjs index                # rebuild the page index
```

| Flag | Meaning |
| --- | --- |
| `--platform`, `-p` | `ios` (default), `ipados`, `macos`, `tvos`, `visionos`, `watchos`, `all` |
| `--limit N` | Max search results (default 12) |
| `--since YYYY-MM-DD` | Filter `updated` by date |
| `--refresh` | Bypass the cache |
| `--json` | Machine-readable output |

`show` defaults to **iOS**: it drops the `Platform considerations` subsections for other
platforms and prints a footer naming what it removed. Nothing outside that section is ever
filtered. Pass `-p all` when a target is genuinely cross-platform, or `-p macos` etc. for one
other platform.

```bash
hig.mjs search "tab bar"                  # what's the page called?
hig.mjs show tab-bars                     # iOS guidance only
hig.mjs show sheets -p ipados             # iPad specifics
hig.mjs show buttons -p all               # every platform
hig.mjs updated --since 2026-01-01        # what changed this year
```

## Workflow: consult before you code

1. **Name the UI problem, not the widget.** "Let people pick a date," not "add a wheel picker."
   The HIG's job is telling you which component that should be.
2. **`search` for the pattern, then `show` it.** Patterns (`modality`, `searching`, `onboarding`,
   `feedback`, `settings`, `entering-data`) describe *when* to use something; Components
   (`sheets`, `alerts`, `pickers`) describe *how*. Read the pattern page first — it's what stops
   an alert from being used where a sheet belongs.
3. **Check the platform section** for the target you're building.
4. **Then map to API** (table below) and write the code.
5. **Cite the page** in your explanation so the user can check you: `sheets`,
   `https://developer.apple.com/design/human-interface-guidelines/sheets`.

When reviewing existing UI, run it in reverse: list the components on screen, `show` each one,
and check the code against its "Best practices" section.

## Where things live

| Building… | Read |
| --- | --- |
| A new app's overall shape | `designing-for-ios`, `design-principles`, `layout` |
| Screen-to-screen navigation | `navigation-and-search`, `tab-bars`, `sidebars`, `split-views` |
| Anything modal | `modality` → then `sheets`, `alerts`, `action-sheets`, `popovers` |
| Forms and input | `entering-data`, `text-fields`, `pickers`, `toggles`, `virtual-keyboards` |
| Lists and collections | `lists-and-tables`, `collections`, `scroll-views` |
| Actions and commands | `menus-and-actions`, `buttons`, `context-menus`, `toolbars` |
| Search | `searching`, `search-fields` |
| Progress and errors | `loading`, `progress-indicators`, `feedback`, `alerts` |
| Color and theming | `color`, `dark-mode`, `materials` |
| Text | `typography`, `writing`, `labels` |
| Icons | `sf-symbols`, `app-icons`, `icons` |
| Accessibility | `accessibility`, `inclusion`, `right-to-left` |
| Onboarding / permissions | `onboarding`, `launching`, `privacy` |
| Notifications | `managing-notifications`, `notifications`, `live-activities` |
| Home screen | `widgets`, `home-screen-quick-actions`, `app-shortcuts` |
| Settings | `settings` |
| Hardware input | `gestures`, `keyboards`, `action-button`, `camera-control`, `digital-crown` |
| Apple frameworks | `apple-pay`, `sign-in-with-apple`, `healthkit`, `siri`, `generative-ai`, `maps` |

`hig.mjs list` prints all 171 slugs if none of these fit.

## HIG → API

| Guideline | SwiftUI | UIKit |
| --- | --- | --- |
| `sheets` | `.sheet`, `.presentationDetents` | `UISheetPresentationController` |
| `alerts` | `.alert` | `UIAlertController(.alert)` |
| `action-sheets` | `.confirmationDialog` | `UIAlertController(.actionSheet)` |
| `tab-bars` | `TabView` | `UITabBarController` |
| `navigation-and-search` | `NavigationStack`, `NavigationSplitView` | `UINavigationController` |
| `sidebars` / `split-views` | `NavigationSplitView` | `UISplitViewController` |
| `searching` | `.searchable` | `UISearchController` |
| `lists-and-tables` | `List` | `UICollectionView` + list layout |
| `context-menus` | `.contextMenu` | `UIContextMenuInteraction` |
| `toolbars` | `.toolbar`, `ToolbarItem` | `UIToolbar`, `navigationItem` |
| `typography` | `.font(.body)` + text styles | `UIFont.preferredFont(forTextStyle:)` |
| `color` | `Color.accentColor`, semantic colors | `UIColor.label`, `.systemBackground` |
| `materials` | `.background(.regularMaterial)`, `.glassEffect` | `UIVisualEffectView` |
| `sf-symbols` | `Image(systemName:)` | `UIImage(systemName:)` |
| `layout` | `.safeAreaInset`, `.scenePadding` | `safeAreaLayoutGuide`, `layoutMarginsGuide` |
| `accessibility` | `.accessibilityLabel`, `.dynamicTypeSize` | `accessibilityLabel`, `adjustsFontForContentSizeCategory` |
| `loading` | `ProgressView` | `UIActivityIndicatorView` |
| `widgets` | WidgetKit + App Intents | — |

Prefer the system component. A stock `List` inherits Dynamic Type, VoiceOver, Dark Mode,
right-to-left, and next year's redesign for free; a hand-rolled one inherits none of it and is
the usual root cause of the checklist failures below.

## Rules that don't move

Short list, worth knowing without a fetch. Everything else: look it up.

- **Hit targets ≥ 44×44 pt** on iOS (60×60 pt in visionOS), whatever the glyph size. — `buttons`
- **Support Dynamic Type.** Use text styles, never hardcoded point sizes. iOS default body is
  17 pt, minimum 11 pt. Layouts must survive the accessibility sizes. — `typography`
- **Contrast:** ≥ 4.5:1 up to 17 pt; ≥ 3:1 at 18 pt or bold (WCAG AA, what Accessibility
  Inspector checks). Verify in both light and dark. — `accessibility`
- **Respect safe areas and layout margins.** Dynamic Island, home indicator, camera housing. —
  `layout`
- **Use semantic colors, not literals**, so Dark Mode and Increase Contrast work. — `color`,
  `dark-mode`
- **Every control needs an accessibility label**, especially icon-only buttons. — `accessibility`
- **Ask for permission in context**, at the moment of use, explaining why — never at launch. —
  `privacy`, `onboarding`
- **Don't restyle standard controls into something unrecognizable**, and don't reinvent
  navigation. Familiarity is the point. — `design-principles`
- **Never block the main thread**; show progress for anything over ~1s. — `loading`

## Review checklist

Applied to a screen or a diff:

- [ ] Standard component used where one exists?
- [ ] Every tap target ≥ 44×44 pt?
- [ ] Text uses text styles and survives the largest accessibility size?
- [ ] Icon-only controls labelled for VoiceOver?
- [ ] Colors semantic; checked in Dark Mode?
- [ ] Content respects safe areas in both orientations?
- [ ] Destructive actions marked (`role: .destructive`) and confirmed?
- [ ] Modal choice matches `modality` — sheet vs. alert vs. popover vs. push?
- [ ] Empty, loading, and error states all designed?
- [ ] Permission prompts in context, with a reason string?
- [ ] Nothing invents a gesture that conflicts with a system one? — `gestures`

## Notes

- **The JSON endpoint is undocumented.** Pages come from
  `developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`, the DocC
  data behind the site. No key, no quota, no rate limit observed — but Apple could change it, and
  the failure mode is a 404 or an HTML body, both of which surface as "No HIG page".
- **Cache** lives in `$TMPDIR/hig-cache` (override with `HIG_CACHE_DIR`): pages for 1 day, the
  index for 1 week. `--refresh` bypasses it. Deliberately outside the repo so fetched pages never
  show up in `git status`.
- **The index costs ~172 requests**, built automatically on first `search`/`list`/`updated` and
  once a week after. `show` doesn't need it, so a straight lookup is always one request.
- **Slugs are stable and hyphenated** (`tab-bars`, `lists-and-tables`). `show` accepts a bare
  slug, a path, or a full URL, and suggests near matches on a typo (`buton` → `buttons`).
- **Images, videos, and interactive examples are dropped** — the renderer emits text. For visual
  specs (icon grids, spacing templates) send the user to the page URL or Apple Design Resources.
- **Guidelines are not App Review rules.** The HIG is design guidance; rejections come from the
  App Review Guidelines, a different document this skill doesn't cover.
- **Tests:** `node ~/.pi/agent/skills/hig/test.mjs` runs the CLI against a stub API (via
  `HIG_API_BASE`) with no network. Run after editing `hig.mjs`. The platform-filter cases are the
  ones that matter — `Platform considerations` mixes level-3 headings with bare "No additional
  considerations for tvOS." paragraphs, and both have to be filtered by the platform they *name*,
  not the section they sit in.
