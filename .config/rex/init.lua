-- Rex config, migrated from Herdr, zellij, Ghostty, tmux, WezTerm and iTerm2.

-- cmd+k clears the terminal; the session picker moves to shift+cmd+k.
rex.bind("cmd+k", "com.superlogical.terminal.clear")
rex.bind("shift+cmd+k", "session.switch")

------------------------------------------------------------------------------
-- Herdr (~/.config/herdr/config.toml), prefix ctrl+b
------------------------------------------------------------------------------
rex.bind("ctrl+b>ctrl+b", "pane.send_key", { key = "ctrl+b" })
rex.bind("ctrl+b>,", "client.tab.rename")
rex.bind("ctrl+b>shift+t", "client.tab.rename")
rex.bind("ctrl+b>o", "pane.focus_next")
rex.bind("ctrl+b>tab", "pane.focus_next")
rex.bind("ctrl+b>h", "pane.focus", { direction = "left" })
rex.bind("alt+h", "pane.focus", { direction = "left" })
rex.bind("ctrl+b>left", "pane.focus", { direction = "left" })
rex.bind("ctrl+b>j", "pane.focus", { direction = "down" })
rex.bind("alt+j", "pane.focus", { direction = "down" })
rex.bind("ctrl+b>down", "pane.focus", { direction = "down" })
rex.bind("ctrl+b>k", "pane.focus", { direction = "up" })
rex.bind("alt+k", "pane.focus", { direction = "up" })
rex.bind("ctrl+b>up", "pane.focus", { direction = "up" })
rex.bind("ctrl+b>l", "pane.focus", { direction = "right" })
rex.bind("alt+l", "pane.focus", { direction = "right" })
rex.bind("ctrl+b>right", "pane.focus", { direction = "right" })

-- herdr's default bindings (not set in its config.toml, so the migration above
-- skipped them). detach (d/q), edit_scrollback (e), open_notification_target
-- (shift+o) and the worktree keys have no Rex equivalent.
--
-- pane.go_to (and pane.view_activity) do nothing unless Rex.app has Settings >
-- Developer > Experimental > New Quick Switcher turned on -- an app setting,
-- not something this file can set.
rex.bind("ctrl+b>shift+tab", "pane.focus_previous")
rex.bind("ctrl+b>v", "pane.split.right")
rex.bind("ctrl+b>-", "pane.split.down")
rex.bind("ctrl+b>x", "pane.close")
rex.bind("ctrl+b>z", "pane.zoom")
rex.bind("ctrl+b>r", "client.mode.enter", { name = "resize" })
rex.bind("ctrl+b>shift+p", "pane.rename")
rex.bind("ctrl+b>g", "pane.go_to")
rex.bind("ctrl+b>c", "client.tab.new")
rex.bind("ctrl+b>n", "client.tab.next")
rex.bind("ctrl+b>p", "client.tab.previous")
rex.bind("ctrl+b>shift+x", "client.tab.close")
for i = 1, 9 do
  rex.bind("ctrl+b>" .. i, "client.tab.goto", { index = i })
end
rex.bind("ctrl+b>w", "session.switch")
rex.bind("ctrl+b>shift+n", "session.new")
rex.bind("ctrl+b>shift+w", "session.rename")
rex.bind("ctrl+b>shift+d", "session.close")
rex.bind("ctrl+b>b", "client.sidebar.toggle")
rex.bind("ctrl+b>s", "client.settings")
rex.bind("ctrl+b>shift+/", "client.palette.toggle")
rex.bind("ctrl+b>shift+r", "client.config.reload")

-- prefix+y: port of the herdr tab-jump plugin (tab-jump/jump.sh), opened in a
-- floating pane over the current tab. It closes itself when the picker exits.
-- Jumping to another session needs Remote Control on (Settings > Rex Server).
local tab_jump = os.getenv("HOME") .. "/.config/rex/tab-jump/jump.sh"

-- Height that fits the list: one line per tab, plus fzf's header and prompt and
-- the pane's own chrome, as a fraction of the window and clamped to 15-70%.
-- Bounds are fractions, so the window's height in rows comes from its tallest
-- tiled block -- exact for one pane or side-by-side splits; a stacked split
-- under-measures, which only makes the panel taller than it needs to be.
local function tab_jump_height(session_id)
  local tabs = 0
  for _, s in ipairs((rex.call("session.list", {}) or {}).sessions or {}) do
    pcall(rex.call, "session.attach", { session_id = s.session_id })
    local ok, v = pcall(rex.call, "session.view", { session_id = s.session_id })
    if ok and v then tabs = tabs + #(v.windows or {}) end
  end

  local rows = 0
  local ok, v = pcall(rex.call, "session.view", { session_id = session_id })
  for _, w in ipairs(ok and v and v.windows or {}) do
    if w.window_id == v.active_window_id then
      for _, layer in ipairs(w.layers or {}) do
        if layer.kind == "tiled" then
          for _, b in ipairs(layer.blocks or {}) do
            local got, size = pcall(rex.call, "block.method", {
              session_id = session_id, block_id = b.block_id, method = "size", args = {},
            })
            if got and size and size.rows and size.rows > rows then rows = size.rows end
          end
        end
      end
    end
  end
  if rows == 0 then return 0.4 end

  local want = (tabs + 5) / rows
  return math.max(0.15, math.min(0.7, want))
end

rex.action{
  name  = "tab_jump",
  title = "Jump to Tab",
  run   = function(ctx)
    local h = tab_jump_height(ctx.session_id)
    return rex.call("session.new_layer", {
      session_id = ctx.session_id,
      bounds = { 0.1, 0.1, 0.8, h },
      focus = true,
      layout = { block = {
        flavor = "com.superlogical.terminal.shell",
        label = "Jump to tab",
        options = { command = { tab_jump } },
      } },
    })
  end,
}
rex.bind("ctrl+b>y", "tab_jump")

------------------------------------------------------------------------------
-- zellij (~/.config/zellij/config.kdl, clear-defaults=true)
------------------------------------------------------------------------------
rex.action{
  name  = "then_normal",
  title = "Run an action and return to normal mode",
  args  = { action = "string", args = "object?" },
  run   = function(ctx, args)
    rex.client.queue(args.action, args.args or {})
    rex.client.queue("client.mode.exit_all")
  end,
}

-- locked passes keys through to the terminal, so it is not exclusive.
for _, m in ipairs({ "pane", "tab", "resize", "move", "scroll", "session", "tmux" }) do
  rex.mode(m, { exclusive = true })
end

local function enter(name) return { name = name } end

-- normal mode (no Rex mode); ctrl+b and alt+h/j/k/l are Herdr's
rex.bind("ctrl+g", "client.mode.enter", enter("locked"))
rex.bind("ctrl+p", "client.mode.enter", enter("pane"))
rex.bind("ctrl+n", "client.mode.enter", enter("resize"))
rex.bind("ctrl+t", "client.mode.enter", enter("tab"))
rex.bind("ctrl+s", "client.mode.enter", enter("scroll"))
rex.bind("ctrl+o", "client.mode.enter", enter("session"))
rex.bind("ctrl+h", "client.mode.enter", enter("move"))
rex.bind("alt+n", "pane.split.auto")
rex.bind("alt+left", "pane.focus", { direction = "left" })
rex.bind("alt+right", "pane.focus", { direction = "right" })
rex.bind("alt+down", "pane.focus", { direction = "down" })
rex.bind("alt+up", "pane.focus", { direction = "up" })

-- bindings every mode except locked repeats
local modes = { "pane", "tab", "resize", "move", "scroll", "session", "tmux" }
for _, m in ipairs(modes) do
  rex.bind(m .. "/alt+n", "pane.split.auto")
  rex.bind(m .. "/alt+h", "pane.focus", { direction = "left" })
  rex.bind(m .. "/alt+left", "pane.focus", { direction = "left" })
  rex.bind(m .. "/alt+l", "pane.focus", { direction = "right" })
  rex.bind(m .. "/alt+right", "pane.focus", { direction = "right" })
  rex.bind(m .. "/alt+j", "pane.focus", { direction = "down" })
  rex.bind(m .. "/alt+down", "pane.focus", { direction = "down" })
  rex.bind(m .. "/alt+k", "pane.focus", { direction = "up" })
  rex.bind(m .. "/alt+up", "pane.focus", { direction = "up" })
end

-- mode switches: each mode's key for going to another mode, and back to normal
local switches = {
  pane    = { ["ctrl+g"] = "locked", ["ctrl+n"] = "resize", ["ctrl+t"] = "tab", ["ctrl+s"] = "scroll",
              ["ctrl+o"] = "session", ["ctrl+h"] = "move", ["ctrl+b"] = "tmux" },
  tab     = { ["ctrl+g"] = "locked", ["ctrl+p"] = "pane", ["ctrl+n"] = "resize", ["ctrl+s"] = "scroll",
              ["ctrl+h"] = "move", ["ctrl+b"] = "tmux", ["ctrl+o"] = "session" },
  resize  = { ["ctrl+g"] = "locked", ["ctrl+p"] = "pane", ["ctrl+t"] = "tab", ["ctrl+s"] = "scroll",
              ["ctrl+o"] = "session", ["ctrl+h"] = "move", ["ctrl+b"] = "tmux" },
  move    = { ["ctrl+g"] = "locked", ["ctrl+p"] = "pane", ["ctrl+t"] = "tab", ["ctrl+n"] = "resize",
              ["ctrl+s"] = "scroll", ["ctrl+o"] = "session" },
  scroll  = { ["ctrl+t"] = "tab", ["ctrl+g"] = "locked", ["ctrl+p"] = "pane", ["ctrl+h"] = "move",
              ["ctrl+o"] = "session", ["ctrl+n"] = "resize" },
  session = { ["ctrl+g"] = "locked", ["ctrl+n"] = "resize", ["ctrl+p"] = "pane", ["ctrl+h"] = "move",
              ["ctrl+b"] = "tmux", ["ctrl+t"] = "tab", ["ctrl+s"] = "scroll" },
  tmux    = { ["ctrl+g"] = "locked", ["ctrl+n"] = "resize", ["ctrl+p"] = "pane", ["ctrl+h"] = "move",
              ["ctrl+t"] = "tab", ["ctrl+s"] = "scroll", ["["] = "scroll" },
}
local to_normal = {
  locked = { "ctrl+g" },
  pane = { "ctrl+p", "enter", "space", "esc" },
  tab = { "ctrl+t", "enter", "space", "esc" },
  resize = { "ctrl+n", "enter", "space", "esc" },
  move = { "ctrl+h", "enter", "space", "esc" },
  scroll = { "ctrl+s", "space", "enter", "esc" },
  session = { "ctrl+o", "enter", "space", "esc" },
  tmux = { "ctrl+o", "enter", "space", "esc" },
}
for m, keys in pairs(switches) do
  for key, target in pairs(keys) do
    rex.bind(m .. "/" .. key, "client.mode.enter", enter(target))
  end
end
for m, keys in pairs(to_normal) do
  for _, key in ipairs(keys) do
    rex.bind(m .. "/" .. key, "client.mode.exit_all")
  end
end

-- pane
for key, dir in pairs({ h = "left", left = "left", l = "right", right = "right",
                        j = "down", down = "down", k = "up", up = "up" }) do
  rex.bind("pane/" .. key, "pane.focus", { direction = dir })
end
rex.bind("pane/p", "pane.focus_next")
rex.bind("pane/n", "then_normal", { action = "pane.split", args = { direction = "auto" } })
rex.bind("pane/d", "then_normal", { action = "pane.split", args = { direction = "down" } })
rex.bind("pane/r", "then_normal", { action = "pane.split", args = { direction = "right" } })
rex.bind("pane/x", "then_normal", { action = "pane.close" })
rex.bind("pane/f", "then_normal", { action = "pane.zoom" })
rex.bind("pane/c", "then_normal", { action = "pane.rename" })

-- tab
rex.bind("tab/r", "then_normal", { action = "client.tab.rename" })
for _, key in ipairs({ "h", "left", "up", "k" }) do rex.bind("tab/" .. key, "client.tab.previous") end
for _, key in ipairs({ "l", "right", "down", "j" }) do rex.bind("tab/" .. key, "client.tab.next") end
rex.bind("tab/n", "then_normal", { action = "client.tab.new" })
rex.bind("tab/x", "then_normal", { action = "client.tab.close" })
for i = 1, 9 do
  rex.bind("tab/" .. i, "then_normal", { action = "client.tab.goto", args = { index = i } })
end
rex.bind("tab/shift+left", "client.tab.move", { direction = "backward" })
rex.bind("tab/shift+right", "client.tab.move", { direction = "forward" })

-- resize
for key, dir in pairs({ h = "left", left = "left", j = "down", down = "down",
                        k = "up", up = "up", l = "right", right = "right" }) do
  rex.bind("resize/" .. key, "pane.resize", { direction = dir })
end

-- move
for key, dir in pairs({ h = "left", left = "left", j = "down", down = "down",
                        k = "up", up = "up", l = "right", right = "right" }) do
  rex.bind("move/" .. key, "pane.move", { direction = dir })
end

-- tmux
rex.bind("tmux/ctrl+b", "then_normal", { action = "pane.send_key", args = { key = "ctrl+b" } })
rex.bind("tmux/shift+'", "then_normal", { action = "pane.split", args = { direction = "down" } })
rex.bind("tmux/shift+5", "then_normal", { action = "pane.split", args = { direction = "right" } })
rex.bind("tmux/z", "then_normal", { action = "pane.zoom" })
rex.bind("tmux/c", "then_normal", { action = "client.tab.new" })
rex.bind("tmux/,", "then_normal", { action = "client.tab.rename" })
rex.bind("tmux/p", "then_normal", { action = "client.tab.previous" })
rex.bind("tmux/n", "then_normal", { action = "client.tab.next" })
for key, dir in pairs({ left = "left", right = "right", down = "down", up = "up",
                        h = "left", l = "right", j = "down", k = "up" }) do
  rex.bind("tmux/" .. key, "then_normal", { action = "pane.focus", args = { direction = dir } })
end
rex.bind("tmux/o", "pane.focus_next")
