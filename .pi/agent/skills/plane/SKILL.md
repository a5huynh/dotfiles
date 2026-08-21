---
name: plane
description: Create, list, update, comment on and close work items (issues) in a self-hosted Plane instance via its REST API. Use when the user wants to file a ticket, log a bug or TODO, check what's in progress, move an item's state, or otherwise track work in Plane.
---

# Plane Work Items

Manages issues ("work items") on the self-hosted Plane instance in the galactus
homelab cluster. No npm install — uses Node's built-in `fetch`.

## Setup

Already configured. `PLANE_API_TOKEN` lives in `~/.config/fish/secrets.fish`
(gitignored, alongside `DNSIMPLE_TOKEN` and `BRAVE_API_KEY`), which
`config.fish` sources on shell start. `set -gx` exports it, so any session
launched from fish inherits it — no per-session setup.

If `whoami` reports the token is missing, the process was almost certainly not
started from a fish shell (GUI launcher, cron, launchd), since environment is
captured at launch. Either relaunch from a terminal or set it explicitly:

```fish
set -gx PLANE_API_TOKEN plane_api_…   # fish
```
```bash
export PLANE_API_TOKEN=plane_api_…    # bash/zsh
```

Optional overrides: `PLANE_BASE_URL` (default
`https://plane.discus-musical.ts.net`) and `PLANE_WORKSPACE` (default
`personal`).

Verify connectivity and which identity the token acts as:

```bash
node ~/.pi/agent/skills/plane/plane.mjs whoami
# acting as  Artoo <artoo@discus-musical.ts.net>
```

## Identity

The configured token belongs to a dedicated agent account, **Artoo**, not a
human one, so everything this skill creates or comments on is attributed to
Artoo in Plane. `whoami` should always report `Artoo` — if it reports a person,
the token is wrong and attribution will be misleading.

Artoo is deliberately a **full member, not a Plane "bot"** (`is_bot=False`,
role `15`), because Plane's UI filters `member__is_bot=False` out of its member
endpoints — a true bot cannot be picked as an assignee. As a full member it is
assignable, and the UI renders `display_name` verbatim (a real bot would be
labelled `first_name` + a hardcoded "Bot" suffix instead, e.g. "ArtooBot").

The cost of that choice: Artoo appears in assignee dropdowns and counts toward
workspace member counts. That is the intended trade.

Tickets can be assigned to it like any teammate, and `--mine` resolves to
whoever the token belongs to:

```bash
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --mine
node ~/.pi/agent/skills/plane/plane.mjs assign HOMELAB-2 Artoo
```

Tokens for a *human* account can be made in the UI (**Workspace Settings → API
tokens**), but prefer the bot so agent activity stays distinguishable.

## Reading

```bash
node ~/.pi/agent/skills/plane/plane.mjs projects
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --state started
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --priority urgent --limit 5
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --mine
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --assignee a5thuynh
node ~/.pi/agent/skills/plane/plane.mjs list HOMELAB --unassigned
node ~/.pi/agent/skills/plane/plane.mjs get HOMELAB-2
node ~/.pi/agent/skills/plane/plane.mjs comments HOMELAB-2
```

`list` sorts urgent → none. States are `backlog`, `unstarted`, `started`,
`completed`, `cancelled`, or a state's display name ("In Progress").

## Writing

```bash
# minimal
node ~/.pi/agent/skills/plane/plane.mjs create HOMELAB "Fix the migrator race"

# with detail
node ~/.pi/agent/skills/plane/plane.mjs create HOMELAB "Back up MinIO attachments" \
    --priority high --state started \
    --description "MinIO is on local-path, outside NAS backups."

node ~/.pi/agent/skills/plane/plane.mjs assign HOMELAB-2 Artoo      # or "me"
node ~/.pi/agent/skills/plane/plane.mjs update HOMELAB-2 --priority urgent --assignee me
node ~/.pi/agent/skills/plane/plane.mjs update HOMELAB-2 --unassign
node ~/.pi/agent/skills/plane/plane.mjs comment HOMELAB-2 "Deployed in helm revision 2."
node ~/.pi/agent/skills/plane/plane.mjs close HOMELAB-2
node ~/.pi/agent/skills/plane/plane.mjs delete HOMELAB-2
```

Priorities: `urgent`, `high`, `medium`, `low`, `none`.

## Reference forms

- Projects accept an identifier (`HOMELAB`), a name (`Homelab`), or a UUID.
- Work items are referenced as `PROJECT-NUMBER` (`HOMELAB-12`), or a UUID plus
  `--project HOMELAB`.
- `--json` on any command prints the raw API response.

## Discovering ids

```bash
node ~/.pi/agent/skills/plane/plane.mjs states HOMELAB
node ~/.pi/agent/skills/plane/plane.mjs labels HOMELAB
node ~/.pi/agent/skills/plane/plane.mjs members          # for --assignee
```

`--label` takes names (`--label bug,infra`). `--assignee` takes display names,
emails, UUIDs, or `me` (`--assignee Artoo,a5thuynh`), matched
case-insensitively.

## Notes on this API

Verified against self-hosted Plane **CE v1.4.1**:

- **The API ignores query-param filters.** `?state__group=`, `?priority=`,
  `?state=<uuid>` and `?sequence_id=` are all accepted and silently return the
  *entire* work-item set. This script therefore filters client-side, including
  when resolving `HOMELAB-12` — trusting the server would resolve the wrong
  item and make `update`/`delete` hit the wrong row. **Do not "optimize" these
  into server-side filters.**
- Auth header is `X-API-Key`, **not** `Authorization: Bearer`.
- `work-items/` and `issues/` are equivalent; `work-items/` is current.
- Descriptions are `description_html`; there is no `description_stripped`.
- Comment authors need `?expand=actor`, otherwise you get a bare UUID.
- **Don't create projects through the API** — upstream bug
  [#8909](https://github.com/makeplane/plane/issues/8909) skips the
  `ProjectIdentifier` row and crashes the web UI for that project. Create
  projects in the UI.
- Pages are not exposed on self-hosted
  ([#8986](https://github.com/makeplane/plane/issues/8986)).

## Deployment

The instance itself lives in `~/Documents/projects/homelab/galactus-cluster`
under `services/plane/` (`just apps::plane-install`). See that repo's
`CLAUDE.md` for deployment gotchas.
