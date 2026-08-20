#!/usr/bin/env node
// Plane work-item CLI — talks to a self-hosted Plane instance over its REST API.
// No dependencies; uses Node's built-in fetch (Node 18+).

const TOKEN = process.env.PLANE_API_TOKEN;
const BASE = (process.env.PLANE_BASE_URL || "https://plane.discus-musical.ts.net").replace(/\/$/, "");
const WORKSPACE = process.env.PLANE_WORKSPACE || "personal";
const API = `${BASE}/api/v1/workspaces/${WORKSPACE}`;
const API_ROOT = `${BASE}/api/v1`;

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(path, { method = "GET", body, root = false } = {}) {
  if (!TOKEN) die("PLANE_API_TOKEN is not set. See SKILL.md for setup.");

  const res = await fetch(`${root ? API_ROOT : API}${path}`, {
    method,
    headers: {
      "X-API-Key": TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or the Tailscale ingress returned HTML rather than JSON.
    die(`${method} ${path} -> ${res.status} (non-JSON response)\n${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const detail = data?.detail || data?.error || JSON.stringify(data);
    if (res.status === 401 || res.status === 403) {
      die(`${res.status}: ${detail}\nCheck PLANE_API_TOKEN (Workspace Settings -> API tokens).`);
    }
    die(`${method} ${path} -> ${res.status}: ${detail}`);
  }
  return data;
}

// Plane paginates with a cursor envelope; walk it so callers get everything.
async function apiAll(path) {
  const sep = path.includes("?") ? "&" : "?";
  let data = await api(`${path}${sep}per_page=100`);
  if (!data?.results) return data;

  const out = [...data.results];
  while (data.next_page_results && data.next_cursor) {
    data = await api(`${path}${sep}per_page=100&cursor=${encodeURIComponent(data.next_cursor)}`);
    out.push(...(data.results || []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _projects = null;
async function projects() {
  if (!_projects) _projects = await apiAll("/projects/");
  return _projects;
}

// Accepts a project UUID, its identifier ("HOMELAB"), or its name ("Homelab").
async function resolveProject(ref) {
  if (!ref) die("A project is required (identifier, name, or UUID).");
  if (UUID_RE.test(ref)) return { id: ref, identifier: ref, name: ref };

  const all = await projects();
  const needle = ref.toLowerCase();
  const hit =
    all.find((p) => p.identifier?.toLowerCase() === needle) ||
    all.find((p) => p.name?.toLowerCase() === needle);

  if (!hit) {
    die(
      `No project matching "${ref}". Available:\n` +
        all.map((p) => `  ${p.identifier}  ${p.name}`).join("\n")
    );
  }
  return hit;
}

// Accepts "HOMELAB-12", or a work-item UUID together with --project.
async function resolveItem(ref, projectOpt) {
  if (UUID_RE.test(ref)) {
    const proj = await resolveProject(projectOpt);
    return { project: proj, id: ref };
  }

  const m = /^(.+)-(\d+)$/.exec(ref || "");
  if (!m) die(`Could not parse "${ref}". Use PROJECT-NUMBER (e.g. HOMELAB-12) or a UUID with --project.`);

  const proj = await resolveProject(m[1]);
  const seq = Number(m[2]);

  // Must match client-side: Plane CE 1.4.x ignores the sequence_id query
  // param and returns every work item, so taking results[0] would silently
  // resolve to the wrong item (and destructive commands would hit it).
  const found = await apiAll(`/projects/${proj.id}/work-items/?expand=state`);
  const all = Array.isArray(found) ? found : found?.results || [];
  const item = all.find((it) => it.sequence_id === seq);

  if (!item) die(`No work item ${ref}.`);
  return { project: proj, id: item.id, item };
}

// Matches a state by group ("started") or by name ("In Progress").
async function resolveState(projectId, ref) {
  const states = await apiAll(`/projects/${projectId}/states/`);
  const needle = ref.toLowerCase();
  const hit =
    states.find((s) => s.group?.toLowerCase() === needle) ||
    states.find((s) => s.name?.toLowerCase() === needle);
  if (!hit) {
    die(
      `No state matching "${ref}". Available:\n` +
        states.map((s) => `  ${s.group.padEnd(11)} ${s.name}`).join("\n")
    );
  }
  return hit;
}

let _me = null;
async function me() {
  if (!_me) _me = await api("/users/me/", { root: true });
  return _me;
}

// Accepts display names, emails, UUIDs, or the literal "me".
async function resolveMembers(names) {
  const members = await apiAll("/members/");
  const flat = members.map((m) => m.member || m);

  return Promise.all(
    names.map(async (n) => {
      if (n.toLowerCase() === "me") return (await me()).id;
      if (UUID_RE.test(n)) return n;

      const needle = n.toLowerCase();
      const hit = flat.find(
        (u) =>
          u.display_name?.toLowerCase() === needle ||
          u.email?.toLowerCase() === needle ||
          `${u.first_name} ${u.last_name}`.trim().toLowerCase() === needle
      );
      if (!hit) {
        die(
          `No member matching "${n}". Available:\n` +
            flat.map((u) => `  ${u.display_name}  ${u.email || ""}`).join("\n")
        );
      }
      return hit.id;
    })
  );
}

async function resolveLabels(projectId, names) {
  const labels = await apiAll(`/projects/${projectId}/labels/`);
  return names.map((n) => {
    const hit = labels.find((l) => l.name.toLowerCase() === n.toLowerCase());
    if (!hit) {
      die(
        `No label "${n}". Available:\n` +
          (labels.length ? labels.map((l) => `  ${l.name}`).join("\n") : "  (none defined)")
      );
    }
    return hit.id;
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const opts = {};
function out(data, render) {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    render(data);
  }
}

function stateName(it) {
  return typeof it.state === "object" ? it.state?.name || "" : it.state_detail?.name || "";
}
function stateGroup(it) {
  return typeof it.state === "object" ? it.state?.group || "" : it.state_detail?.group || "";
}

function assigneeNames(it) {
  return (it.assignees || [])
    .map((a) => (typeof a === "object" ? a.display_name || a.email : a))
    .filter(Boolean)
    .join(",");
}

function itemLine(it, proj) {
  const ref = `${proj.identifier}-${it.sequence_id}`;
  const who = assigneeNames(it) || "-";
  return `${ref.padEnd(14)} ${(it.priority || "none").padEnd(8)} ${stateName(it).padEnd(13)} ${who.padEnd(12)} ${it.name}`;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  async projects() {
    const all = await projects();
    out(all, (d) => {
      if (!d.length) return console.log("No projects.");
      console.log("IDENTIFIER   NAME                 ID");
      for (const p of d) {
        console.log(`${(p.identifier || "").padEnd(12)} ${(p.name || "").padEnd(20)} ${p.id}`);
      }
    });
  },

  async states([projectRef]) {
    const proj = await resolveProject(projectRef);
    const states = await apiAll(`/projects/${proj.id}/states/`);
    out(states, (d) => {
      console.log("GROUP        NAME");
      for (const s of d) console.log(`${s.group.padEnd(12)} ${s.name}`);
    });
  },

  async labels([projectRef]) {
    const proj = await resolveProject(projectRef);
    const labels = await apiAll(`/projects/${proj.id}/labels/`);
    out(labels, (d) =>
      d.length ? d.forEach((l) => console.log(l.name)) : console.log("No labels defined.")
    );
  },

  async members([projectRef]) {
    const path = projectRef
      ? `/projects/${(await resolveProject(projectRef)).id}/members/`
      : "/members/";
    const members = await apiAll(path);
    out(members, (d) => {
      for (const m of d) {
        const u = m.member || m;
        console.log(`${(u.display_name || u.email || "").padEnd(24)} ${u.id}`);
      }
    });
  },

  async list([projectRef]) {
    const proj = await resolveProject(projectRef);

    // Filtering is done client-side on purpose: Plane CE 1.4.x accepts
    // state__group / state / priority query params but ignores them and
    // returns the full set, so trusting the server would silently
    // produce wrong results.
    let items = await apiAll(`/projects/${proj.id}/work-items/?expand=state,assignees`);
    items = Array.isArray(items) ? items : items?.results || [];

    if (opts.assignee || opts.mine) {
      const [who] = await resolveMembers([opts.mine ? "me" : opts.assignee]);
      items = items.filter((it) =>
        (it.assignees || []).some((a) => (typeof a === "object" ? a.id : a) === who)
      );
    }
    if (opts.unassigned) items = items.filter((it) => !(it.assignees || []).length);

    if (opts.state) {
      const needle = opts.state.toLowerCase();
      if (STATE_GROUPS.includes(needle)) {
        items = items.filter((it) => stateGroup(it).toLowerCase() === needle);
      } else {
        const st = await resolveState(proj.id, opts.state);
        items = items.filter((it) => stateName(it).toLowerCase() === st.name.toLowerCase());
      }
    }
    if (opts.priority) {
      if (!PRIORITIES.includes(opts.priority)) die(`--priority must be one of: ${PRIORITIES.join(", ")}`);
      items = items.filter((it) => (it.priority || "none") === opts.priority);
    }

    // Most useful default ordering for an agent: worst priority first.
    items.sort((a, b) => PRIORITIES.indexOf(a.priority || "none") - PRIORITIES.indexOf(b.priority || "none"));
    if (opts.limit) items = items.slice(0, Number(opts.limit));

    out(items, (d) => {
      if (!d.length) return console.log("No matching work items.");
      console.log("REF            PRIORITY STATE         ASSIGNEE     NAME");
      for (const it of d) console.log(itemLine(it, proj));
      console.log(`\n${d.length} item(s)`);
    });
  },

  async get([ref]) {
    const { project, id } = await resolveItem(ref, opts.project);
    const it = await api(`/projects/${project.id}/work-items/${id}/?expand=state,assignees,labels`);
    out(it, (d) => {
      console.log(`${project.identifier}-${d.sequence_id}  ${d.name}`);
      console.log(`state     ${d.state?.name || d.state}`);
      console.log(`priority  ${d.priority}`);
      console.log(`created   ${d.created_at}`);
      if (d.assignees?.length) {
        console.log(`assignees ${d.assignees.map((a) => a.display_name || a.email || a).join(", ")}`);
      }
      if (d.labels?.length) console.log(`labels    ${d.labels.map((l) => l.name || l).join(", ")}`);
      const desc = stripHtml(d.description_html || "");
      if (desc) console.log(`\n${desc}`);
      console.log(`\n${BASE}/${WORKSPACE}/projects/${project.id}/issues/${d.id}`);
    });
  },

  async create([projectRef, ...rest]) {
    const proj = await resolveProject(projectRef);
    const name = (opts.name || rest.join(" ")).trim();
    if (!name) die('A title is required: create HOMELAB "Fix the thing"');

    const body = { name };
    if (opts.description) body.description_html = `<p>${escapeHtml(opts.description)}</p>`;
    if (opts.priority) {
      if (!PRIORITIES.includes(opts.priority)) die(`--priority must be one of: ${PRIORITIES.join(", ")}`);
      body.priority = opts.priority;
    }
    if (opts.state) body.state = (await resolveState(proj.id, opts.state)).id;
    if (opts.label) body.labels = await resolveLabels(proj.id, listOpt(opts.label));
    if (opts.assignee) body.assignees = await resolveMembers(listOpt(opts.assignee));

    const it = await api(`/projects/${proj.id}/work-items/`, { method: "POST", body });
    out(it, (d) => {
      console.log(`created ${proj.identifier}-${d.sequence_id}  ${d.name}`);
      console.log(`${BASE}/${WORKSPACE}/projects/${proj.id}/issues/${d.id}`);
    });
  },

  async update([ref]) {
    const { project, id } = await resolveItem(ref, opts.project);
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.description) body.description_html = `<p>${escapeHtml(opts.description)}</p>`;
    if (opts.priority) {
      if (!PRIORITIES.includes(opts.priority)) die(`--priority must be one of: ${PRIORITIES.join(", ")}`);
      body.priority = opts.priority;
    }
    if (opts.state) body.state = (await resolveState(project.id, opts.state)).id;
    if (opts.label) body.labels = await resolveLabels(project.id, listOpt(opts.label));
    if (opts.assignee) body.assignees = await resolveMembers(listOpt(opts.assignee));
    if (opts.unassign) body.assignees = [];
    if (!Object.keys(body).length) {
      die("Nothing to update. Pass --name, --state, --priority, --description, --label, --assignee or --unassign.");
    }

    const it = await api(`/projects/${project.id}/work-items/${id}/`, { method: "PATCH", body });
    out(it, (d) => console.log(`updated ${project.identifier}-${d.sequence_id}`));
  },

  async close([ref]) {
    opts.state = opts.state || "completed";
    return commands.update([ref]);
  },

  async assign([ref, who]) {
    if (!who && !opts.assignee) die('Who? e.g. assign HOMELAB-2 agent   (or "me")');
    opts.assignee = opts.assignee || who;
    return commands.update([ref]);
  },

  async comment([ref, ...rest]) {
    const { project, id } = await resolveItem(ref, opts.project);
    const text = (opts.body || rest.join(" ")).trim();
    if (!text) die('Comment text is required: comment HOMELAB-1 "done"');

    const c = await api(`/projects/${project.id}/work-items/${id}/comments/`, {
      method: "POST",
      body: { comment_html: `<p>${escapeHtml(text)}</p>` },
    });
    out(c, () => console.log(`commented on ${ref}`));
  },

  async comments([ref]) {
    const { project, id } = await resolveItem(ref, opts.project);
    const list = await apiAll(`/projects/${project.id}/work-items/${id}/comments/?expand=actor`);
    out(list, (d) => {
      if (!d.length) return console.log("No comments.");
      for (const c of d) {
        const who = c.actor?.display_name || c.actor?.email || c.created_by || "?";
        console.log(`--- ${who}  ${c.created_at}`);
        console.log(stripHtml(c.comment_html || ""));
      }
    });
  },

  async delete([ref]) {
    const { project, id } = await resolveItem(ref, opts.project);
    await api(`/projects/${project.id}/work-items/${id}/`, { method: "DELETE" });
    console.log(`deleted ${ref}`);
  },

  async whoami() {
    const me = await api("/users/me/", { root: true });
    const all = await projects();
    out({ ...me, workspace: WORKSPACE, base_url: BASE, projects: all.length }, () => {
      console.log(`acting as  ${me.display_name} <${me.email}>`);
      console.log(`user id    ${me.id}`);
      console.log(`workspace  ${WORKSPACE}`);
      console.log(`base url   ${BASE}`);
      console.log(`projects   ${all.length}`);
    });
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").trim();
}
function listOpt(v) {
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const USAGE = `plane — work items on a self-hosted Plane instance

Usage: plane.mjs <command> [args] [--flags]

  whoami                          Verify token, workspace and connectivity
  projects                        List projects
  states <project>                List workflow states
  labels <project>                List labels
  members [project]               List members (for --assignee ids)

  list <project>                  List work items
      --state <group|name>        backlog|unstarted|started|completed|cancelled, or a state name
      --priority <p>              urgent|high|medium|low|none
      --assignee <who>            display name, email, UUID, or "me"
      --mine                      Shorthand for --assignee me
      --unassigned
      --limit <n>
  get <REF>                       Show one work item (e.g. HOMELAB-12)
  create <project> "<title>"      Create a work item
      --description <text>  --priority <p>  --state <s>
      --label <a,b>         --assignee <who,...>
  update <REF>                    Change --name/--state/--priority/--description/--label/--assignee
  assign <REF> <who>              Assign to a member ("me", a display name, or UUID)
  close <REF>                     Shorthand for --state completed
  comment <REF> "<text>"          Add a comment
  comments <REF>                  List comments
  delete <REF>                    Delete a work item

Global flags: --json  --project <p>  (for UUID refs)

Env: PLANE_API_TOKEN (required), PLANE_BASE_URL, PLANE_WORKSPACE`;

const argv = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--mine") opts.mine = true;
  else if (a === "--unassigned") opts.unassigned = true;
  else if (a === "--unassign") opts.unassign = true;
  else if (a.startsWith("--")) {
    const key = a.slice(2);
    const eq = key.indexOf("=");
    if (eq !== -1) opts[key.slice(0, eq)] = key.slice(eq + 1);
    else opts[key] = argv[++i];
  } else positional.push(a);
}

const cmd = positional.shift();
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}
if (!commands[cmd]) die(`Unknown command "${cmd}". Run with no arguments for usage.`);

commands[cmd](positional).catch((e) => die(e.message));
