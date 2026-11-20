-- Snapshot every tab in every session for jump.sh, as one JSON array.
-- Run with `rex do rows.lua --json`. One rex do connection makes all the calls,
-- which is what keeps this fast: spawning `rex` per block per field would cost a
-- process and a round-trip each.
--
-- A tab's "lead" block is the first one an agent reports a status from, else the
-- block focused in that tab. Only tiled layers are read, which also keeps the
-- picker's own floating pane out of the list.

local function call(method, args)
  local ok, res = pcall(rex.call, method, args)
  if ok then return res end
  return nil
end

local function block_method(session_id, block_id, method)
  return call("block.method", {
    session_id = session_id, block_id = block_id, method = method, args = {},
  })
end

local rows = {}
local list = call("session.list", {}) or { sessions = {} }

for snum, s in ipairs(list.sessions or {}) do
  -- session.view fails with `conflict` until this connection attaches.
  call("session.attach", { session_id = s.session_id })
  local view = call("session.view", { session_id = s.session_id })
  for wnum, w in ipairs(view and view.windows or {}) do
    local blocks = {}
    for _, layer in ipairs(w.layers or {}) do
      if layer.kind == "tiled" then
        for _, b in ipairs(layer.blocks or {}) do
          if b.creator_name == "com.superlogical.terminal" then
            table.insert(blocks, b.block_id)
          end
        end
      end
    end

    if #blocks > 0 then
      local lead, status
      for _, id in ipairs(blocks) do
        local ps = block_method(s.session_id, id, "program_status")
        local rec = ps and ps.records and ps.records[1]
        if rec and rec.effective_app then
          lead, status = id, rec.state
          break
        end
      end
      if not lead then
        for _, id in ipairs(blocks) do
          if id == w.focused_block_id then lead = id end
        end
        lead = lead or blocks[1]
      end

      local proc = block_method(s.session_id, lead, "process")
      local cwd = proc and proc.foreground and proc.foreground.cwd
      if not cwd then
        local pwd = block_method(s.session_id, lead, "pwd")
        cwd = pwd and pwd.pwd and pwd.pwd:gsub("^file://[^/]*", "")
      end
      local title = block_method(s.session_id, lead, "title")

      table.insert(rows, {
        session_id = s.session_id,
        session = s.label or s.session_id,
        snum = snum,
        window_id = w.window_id,
        window = w.label or w.window_id,
        wnum = wnum,
        block_id = lead,
        here = view.active_window_id == w.window_id,
        status = status or "",
        title = title and title.title or "",
        cwd = cwd or "",
      })
    end
  end
end

return rows
