---
name: skill-audit
description: Audit an agent skill catalog for routing ambiguity using the TypeSafe System One API — find skill descriptions that overlap so badly an agent could load the wrong one, skills that never get selected, and prompts that fire a skill when none should. Use when adding or editing a skill, when an agent keeps picking the wrong skill, or when asked to check whether skill descriptions are distinct.
---

# Skill catalog audit

An agent picks a skill from its **name and description alone**. Two descriptions that read
alike are a silent bug: nothing errors, the wrong skill just loads. This asks a model the
same question the agent faces and reports where the catalog is ambiguous.

Dependency-free — Node's built-in `fetch`, no npm install.

## Setup

Get a key from <https://console.typesafe.ai/settings/keys>, then in `secrets.fish`:

```fish
set -x TYPESAFE_API_TOKEN …        # also accepts TYPESAFE_API_KEY
```

> The official TypeSafe SDKs read `TYPESAFE_API_KEY`. This tool accepts either, but if you
> ever reach for the Python/JS SDK it will not see `TYPESAFE_API_TOKEN`.

Optional: `TYPESAFE_API_BASE` (proxy/testing), `TYPESAFE_MODEL` (default `jev-latest`).

## Find ambiguous descriptions

`overlap` needs **no test prompts** — it reads the catalog and asks, for every pair, whether
one request could plausibly match both.

```bash
node ~/.pi/agent/skills/skill-audit/skill-audit.mjs overlap --host both
```

```
  0.91  ▲  peon-ping-config      ↔  peon-ping-toggle
  0.87  ▲  hig                   ↔  swiftui-specialist
  0.86  ▲  docs                  ↔  web-search
```

Read the two descriptions before believing a hit. The top one above is real and quotable:
`peon-ping-toggle` ends with "Also handles config changes like volume, pack rotation,
categories — any peon-ping setting", which is exactly `peon-ping-config`'s job.

**A flagged pair is a lint, not a failure.** `overlap` measures whether two descriptions
*could* be confused; it does not observe a misroute. That same 0.91 pair routes correctly
and decisively on concrete prompts — "set the peon volume to 50%" goes to `peon-ping-config`
at p=0.93, "turn peon sounds back on" to `peon-ping-toggle` at p=1.00. Treat a hit as a
prompt to go read the two descriptions, and use `audit` for ground truth.

Every pair rides as a parallel Noul in one request, with the catalog in `state`. State is
ingested once and all questions are evaluated against it, so 253 pairs cost ~$0.002 and
about 1.5 seconds rather than 253 round-trips.

## Check routing against real prompts

```bash
node ~/.pi/agent/skills/skill-audit/skill-audit.mjs route "review PR 983" --host both
node ~/.pi/agent/skills/skill-audit/skill-audit.mjs \
  audit --prompts ~/.pi/agent/skills/skill-audit/prompts.example.json
```

`route` prints the full probability distribution for a prompt. `audit` runs a prompt file
and reports four verdicts: `ok`, `narrow` (right answer, top-two gap under `--margin` — it
could flip), `mismatch` (wrong skill), `false-fire` (a skill fired where `expect` was null).
It also lists skills **never selected** by any prompt. That means either a description
nothing can reach *or* — far more often — that your prompt file simply has no case for it.
Check which before acting on it.

Prompts file is a JSON array of `{"prompt": "...", "expect": "skill-name" | null}`, where
`null` means no skill should fire.

Exit status is **1** when `overlap` or `audit` finds a problem, so it can gate a commit.
A pair the API returned no answer for is reported as `NOT CHECKED` and also exits 1 — an
incomplete run must not read as a clean bill of health.

## Reading the numbers

**A Noul at 0.5 is maximum uncertainty, not "medium overlap".** It means the model assigns
roughly equal probability to yes and no. Thresholding there flags its shrugs — on a 24-skill
catalog a 0.5 cutoff flagged 58 pairs of 276, which is unusable. The default is `0.75`, where
it is actually asserting the pair collides. Tune `--threshold` against your own catalog.

Skills with `disable-model-invocation: true` are **excluded by default**: the model can never
auto-pick them, so counting them as routing conflicts is noise. Pass `--include-manual` to
keep them. Note this is the hyphenated key — peon-ping's underscored `user_invocable` gates
the *user*, not the model, and is deliberately not treated the same way.

## Options

| Flag | Meaning |
|---|---|
| `--host pi\|claude\|both` | Which catalog (default `pi`). `both` dedupes skills symlinked into each. |
| `--dir PATH` | Audit an arbitrary directory of `<name>/SKILL.md` instead |
| `--threshold N` | Overlap noul cutoff (default `0.75`) |
| `--margin N` | Flag a route whose top-two gap is under this (default `0.15`) |
| `--max-desc N` | Truncate descriptions to N chars (default `0`, no limit) |
| `--chunk N` | Max questions per request (default `40`) |
| `--include-manual` | Keep `disable-model-invocation: true` skills |

Skill names and descriptions are read from third-party `SKILL.md` files, so names are
constrained to `[\w.-]` and control characters are stripped from both — a name reaches the
model's *instruction* channel, and a description gets printed straight to your terminal.
| `--json` | Machine-readable output |

## Testing

```bash
node ~/.pi/agent/skills/skill-audit/test.mjs
```

Runs the whole CLI against a self-terminating stub of the System One endpoint plus a fixture
catalog in `$TMPDIR` — no API key, no network, no model. Also unit-tests the frontmatter
reader, which has to handle the folded (`>`) and literal (`|`) block scalars that long
descriptions use.
