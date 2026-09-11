---
name: review
description: Review uncommitted and unlanded changes in the current working tree before landing them — "review my diff", "review this before I push", "pre-landing review". Reports findings with evidence; does not edit, commit, or push. For a PR or branch that is not the current tree, use review-pr.
user-invocable: true
argument-hint: "[base branch]"
---

# Review the current diff

Report-only. Find real bugs in the diff, cite evidence for each one, and stop. Do not
edit files, commit, or push unless the user asks after reading the report.

## Step 1: Get the right diff

Stale bases produce phantom findings — code that looks missing is often already on the
base branch. Fetch first, then diff against the merge base so the review covers this
branch's work only, committed and uncommitted alike:

```sh
base=${1:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)}
base=${base#origin/}; base=${base:-main}
git fetch origin "$base" --quiet
mb=$(git merge-base "origin/$base" HEAD) || echo "no merge base with origin/$base"
git diff "$mb" --stat
git diff "$mb"
git ls-files --others --exclude-standard   # untracked — invisible to git diff
```

`git diff` covers **tracked** files only, so a brand-new file does not show up in it at
all — not in the diff, not even in `--stat`. Read every path `ls-files --others` prints
in full, or the review silently skips whole new modules and reports clean on work it
never looked at.

Strip the prefix with `${base#origin/}` and default with `${base:-main}` rather than piping
to `sed ... || echo main` — in a pipeline the exit status is `sed`'s, which succeeds on
empty input, so the fallback never fires and `base` ends up empty.


Read the **entire** diff before writing a single finding. Anything already handled a few
lines down is not a finding.

## Step 2: Look for these

Real bug classes, roughly by how much they cost when missed. Skip whatever doesn't apply
to the languages in the diff.

- **Data & query safety** — string-interpolated SQL; check-then-write that should be one
  atomic statement; writes that bypass model validation; queries inside loops (N+1);
  column/field names that don't match the schema (these fail silently, returning empty).
- **Concurrency** — read-check-write with no unique constraint behind it; find-or-create
  without a unique index; status transitions that don't guard on the old status; shared
  mutable state reached from more than one task or thread. In Rust, also: `unwrap` on a
  lock whose poisoning is reachable, and blocking calls inside `async`.
- **Untrusted input reaching a sink** — user- or model-supplied values interpolated into
  a shell command, `eval`, a raw HTML sink, a filesystem path, or an outbound URL.
  Validate at the boundary, not at the point of use.
- **Error handling** — swallowed exceptions; a bare `except`/`catch` that hides a real
  failure; `unwrap`/`expect`/`!` on input that can legitimately be absent; error paths
  that leave state half-written.
- **Completeness of new values** — a new enum variant, status, tier, or constant must be
  handled everywhere its siblings are. **This requires reading outside the diff:** grep
  for a sibling value, then *read* each match — allowlists, `match`/`switch` arms, and
  frontend option lists are the usual misses. A non-exhaustive `match` is a compile error
  in Rust but a wrong default in most other languages.
- **Boundary type changes** — values crossing a language or serialization boundary where
  a number can become a string. Matters most for anything hashed, compared, or used as a
  cache key.
- **Time and dates** — "today" assumed to mean a full 24h; two related features on
  different bucket sizes; naive local time where the input is UTC.
- **Async/blocking mixing** — synchronous IO, `sleep`, or subprocess calls inside an async
  function, which stalls the whole event loop.
- **Config and CI** — hardcoded secrets where a secret reference belongs; version or path
  strings that must agree across files and now don't; a publish step that breaks on rerun.

Also flag anything that contradicts this repo's own conventions (`CLAUDE.md`, `AGENTS.md`,
neighbouring code) — including a new dependency added without discussion.

## Step 3: Verify before reporting

**Quote the line that motivates each finding.** This is the rule that keeps the review
honest, because the plausible-sounding finding about code that doesn't exist is the main
failure mode of automated review.

- "Field X is missing" → quote the type or schema where X would be declared.
- "This can be None/nil" → quote where the value is constructed.
- "These two race" → quote both sides.

If you can't produce that quote, you haven't verified it — drop it, or list it under
`Unverified` for the user to judge. Never promote a guess by asserting confidence in it.

The same standard applies to clearing code: "handled elsewhere" needs the handling code
cited, and "tests cover this" needs the test named. "Probably fine" is not a conclusion —
verify it or say it's unchecked.

**Don't flag:**

- Anything already fixed elsewhere in this diff.
- Style, naming, or consistency-only churn; redundancy that aids readability.
- "Add a comment explaining this constant" — thresholds get tuned, comments rot.
- Missing edge-case handling for inputs the call sites make impossible.
- Speculative performance work with no measurement behind it.
- Deliberate choices the surrounding code or a comment already explains.

## Step 4: Report

Terse. One line for the problem, one for the fix. No preamble, no score, no "overall this
looks good." Order by severity: `high` (data loss, security, corruption), `medium` (wrong
behavior on a reachable path), `low` (works, but will bite later).

```
Review: <n> findings (<h> high, <m> medium, <l> low) — <files> files, +<a>/-<d>

[high] path/to/file.rs:42 — Status transition isn't atomic; two workers can both apply it.
  > let s = load(id); if s == Draft { save(id, Published) }
  Fix: single UPDATE guarded on `WHERE status = 'draft'`.

[low] path/to/other.py:88 — Bare `except` hides the parse failure below it.
  > except: return None
  Fix: `except ValueError`.

Unverified: <finding> — couldn't confirm; <what to check>.
```

If nothing turns up: `Review: no findings — <files> files, +<a>/-<d>.` Say that and stop;
don't pad it with observations.

End by offering the fixes as a batch and waiting. If the user takes them, apply the fixes
only — no commit, no push, no PR.
