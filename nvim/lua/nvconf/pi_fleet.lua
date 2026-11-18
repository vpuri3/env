-- pi-fleet: the nvim half of a pi | nvim session window (~/env/docs/pi-fleet-design.md §11).
--
-- Loaded by nvconf/init.lua only when M.paired(): $PI_FLEET_SESSION and $PI_FLEET_CTL_SOCK
-- are set and this is not an nvim nested in another nvim's terminal ($NVIM), i.e. in the nvim
-- pane that `pi-fleet pair` starts next to a pi. Other nvims (including ones started by the
-- agent's bash commands, which inherit $PI_FLEET_SESSION only) never load it.
--
--   * File buffers are read-only; again after every write (`:w!` clears 'readonly').
--   * `:w!`  = save + note: pi gets the diff with your next message.
--   * `:w!!` = save + interrupt: pi gets the diff now (steer). `:w!!` is not a native
--     command: a cmdline <CR> mapping (defined here only) rewrites it to :PiWriteSteer.
--   * Every write sends one JSON line {type="user_edit", mode, path, diff, ...} to
--     $PI_FLEET_CTL_SOCK (schema: pi/extensions/fleet/protocol.ts).
--   * pi calls agent_changed(paths) / checktime_all() over this nvim's --listen socket
--     (pi/extensions/fleet/nvim.ts, msgpack-RPC nvim_exec_lua; paths travel as data).
--     Unmodified buffers reload silently; modified ones are left alone and marked as a
--     conflict (:PiDiff, :e!). No W12 prompt ever blocks (FileChangedShell).
--   * :PiHelp, :PiDiff, :PiFocus (back to the pi's pane), :PiWriteSteer.

local M = {}

local uv = vim.uv or vim.loop

local MAX_LINE = 64 * 1024 -- control socket line cap (protocol.ts CONTROL_MAX_LINE)
local MAX_DIFF = 48 * 1024 -- diff bytes sent; the rest is summarised by pi (edits.ts)
local MAX_FILE = 4 * 1024 * 1024 -- files larger than this are not diffed
local CMAP_DESC = "pi-fleet: :w!! = save + interrupt pi"

-- Per-buffer state: pending[buf] = { path, old, created } between BufWritePre and Post.
local pending = {}

local function env(name)
    local v = vim.env[name]
    if v == nil or v == "" then
        return nil
    end
    return v
end

--- Keep in sync with the inline check in nvconf/init.lua.
function M.paired()
    return env("PI_FLEET_SESSION") ~= nil and env("PI_FLEET_CTL_SOCK") ~= nil and env("NVIM") == nil
end

local function notify(msg, level)
    vim.notify("pi ▸ " .. msg, level or vim.log.levels.INFO)
end

--- A buffer that holds a real file (not nvim-tree, telescope, fugitive, help, terminal, ...).
local function is_file_buf(buf)
    if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "" then
        return false
    end
    local name = vim.api.nvim_buf_get_name(buf)
    return name ~= "" and not name:match("^%a[%w+.-]*://")
end

local function read_file(path)
    local st = uv.fs_stat(path)
    if not st or st.type ~= "file" then
        return nil, false
    end
    if st.size > MAX_FILE then
        return nil, true
    end
    local f = io.open(path, "rb")
    if not f then
        return nil, false
    end
    local text = f:read("*a")
    f:close()
    return text, false
end

local function realpath(path)
    return uv.fs_realpath(path) or vim.fn.fnamemodify(path, ":p")
end

-- ---------------------------------------------------------------- sending

--- Send one JSON line to pi's control socket. Synchronous until the line is written (waits
--- up to 1 s) so that `:wq!` still delivers before nvim exits; returns true when it was sent.
--- The one-line reply ({"ok":...}) is read afterwards without blocking, within the same 1 s
--- budget; `on_reply(err)` then runs on the main loop with pi's error when it answered
--- ok:false and nil otherwise (no reply in time counts as delivered). Not blocking on the reply
--- keeps RPC requests from pi from being run inside this write's autocmd any longer than before.
function M.send(msg, on_reply)
    local sock = env("PI_FLEET_CTL_SOCK")
    if not sock then
        notify("saved, but $PI_FLEET_CTL_SOCK is not set: pi was not told", vim.log.levels.WARN)
        return false
    end
    local line = vim.json.encode(msg) .. "\n"
    -- JSON escaping can grow the diff past the socket's line cap: cut it further.
    while #line > MAX_LINE and type(msg.diff) == "string" and msg.diff ~= "" do
        local half = msg.diff:sub(1, math.floor(#msg.diff / 2))
        msg.diff = half:sub(1, (half:match(".*()\n") or 0))
        msg.truncated = true
        line = vim.json.encode(msg) .. "\n"
    end
    if #line > MAX_LINE then
        notify("saved, but the message is too large for pi", vim.log.levels.WARN)
        return false
    end
    local pipe = uv.new_pipe(false)
    local timer = uv.new_timer()
    local sent, finished, err, reply = false, false, nil, ""
    local function finish()
        if finished then
            return
        end
        finished = true
        timer:stop()
        timer:close()
        if not pipe:is_closing() then
            pipe:close()
        end
        if not sent or not on_reply then
            return
        end
        local rejected
        local first = reply:match("^[^\n]*")
        if first and first ~= "" then
            local ok, r = pcall(vim.json.decode, first)
            if ok and type(r) == "table" and r.ok == false then
                rejected = tostring(r.error or "unknown error")
            end
        end
        vim.schedule(function()
            on_reply(rejected)
        end)
    end
    timer:start(1000, 0, finish) -- the whole budget: connect, write and reply
    pipe:connect(sock, function(cerr)
        if cerr then
            err = cerr
            return finish()
        end
        pipe:read_start(function(rerr, data)
            if rerr or data == nil then
                return finish() -- error or EOF
            end
            reply = reply .. data
            if reply:find("\n", 1, true) then
                finish()
            end
        end)
        pipe:write(line, function(werr)
            if werr then
                err = werr
                return finish()
            end
            sent = true
            pipe:shutdown()
        end)
    end)
    vim.wait(1000, function()
        return sent or finished
    end, 10)
    if not sent then
        finish()
        notify("saved, but pi is not reachable (" .. tostring(err or "timeout") .. "): pi was not told",
            vim.log.levels.WARN)
        return false
    end
    return true
end

--- Count +/- lines of a unified diff body (no file header).
local function diff_counts(diff)
    local added, removed = 0, 0
    for line in diff:gmatch("[^\n]*") do
        local c = line:sub(1, 1)
        if c == "+" then
            added = added + 1
        elseif c == "-" then
            removed = removed + 1
        end
    end
    return added, removed
end

local function now_ms()
    local s, us = uv.gettimeofday()
    return s * 1000 + math.floor(us / 1000)
end

local function text_diff(a, b)
    local fn = (vim.text and vim.text.diff) or vim.diff
    local ok, d = pcall(fn, a, b, { result_type = "unified", ctxlen = 3 })
    if ok and type(d) == "string" then
        return d
    end
    return nil
end

-- ---------------------------------------------------------------- writes

local function before_write(args)
    if not is_file_buf(args.buf) then
        return
    end
    local path = vim.fn.fnamemodify(args.file ~= "" and args.file or vim.api.nvim_buf_get_name(args.buf), ":p")
    local old, toolarge = read_file(path)
    pending[args.buf] = { path = path, old = old, toolarge = toolarge, created = not uv.fs_stat(path) }
end

local function after_write(args)
    local buf = args.buf
    local p = pending[buf]
    pending[buf] = nil
    local mode = vim.b[buf].pi_fleet_write_mode == "steer" and "steer" or "note"
    vim.b[buf].pi_fleet_write_mode = nil
    if not is_file_buf(buf) then
        return
    end
    vim.b[buf].pi_fleet_conflict = nil
    -- :w! cleared 'readonly'; the buffer goes back to read-only after every write.
    vim.bo[buf].readonly = true
    if not p then
        return
    end
    local new, toolarge = read_file(p.path)
    local diff, truncated, added, removed = "", false, 0, 0
    if p.toolarge or toolarge or new == nil then
        truncated = true
    else
        if p.old == new then
            notify("saved " .. vim.fn.fnamemodify(p.path, ":~:.") .. " (no changes, pi not told)")
            return
        end
        local d = text_diff(p.old or "", new)
        if d == nil or d == "" then
            -- no usable diff for a real change: same as too large, pi reads the file
            truncated = true
        end
        diff = d or ""
        added, removed = diff_counts(diff) -- of the whole change, before any cut
        if #diff > MAX_DIFF then
            -- cut at a line boundary
            local cut = diff:sub(1, MAX_DIFF)
            diff = cut:sub(1, (cut:match(".*()\n") or #cut))
            truncated = true
        end
    end
    local msg = {
        type = "user_edit",
        v = 1,
        mode = mode,
        path = realpath(p.path),
        diff = diff,
        added = added,
        removed = removed,
        created = p.created,
        truncated = truncated,
        session = env("PI_FLEET_SESSION") or "",
        time = now_ms(),
    }
    local name = vim.fn.fnamemodify(p.path, ":~:.")
    M.send(msg, function(rejected)
        if rejected then
            notify("saved, but pi rejected the message: " .. rejected, vim.log.levels.WARN)
            return
        end
        local what = mode == "steer" and "pi interrupted with" or "pi gets with your next message:"
        notify(string.format("%s %s (+%d −%d)", what, name, added, removed))
    end)
end

--- :PiWriteSteer [file] — `write!` and tell pi now (`:w!!` is rewritten to this).
function M.write_steer(opts)
    local buf = vim.api.nvim_get_current_buf()
    vim.b[buf].pi_fleet_write_mode = "steer"
    local ok, err = pcall(vim.cmd, { cmd = "write", bang = true, args = opts and opts.fargs or {} })
    if vim.api.nvim_buf_is_valid(buf) then
        vim.b[buf].pi_fleet_write_mode = nil
    end
    if not ok then
        vim.api.nvim_echo({ { tostring(err):gsub("^Vim:", ""), "ErrorMsg" } }, true, {})
    end
end

--- The cmdline <CR>: `:w!!` → :PiWriteSteer, everything else unchanged.
function M.cmdline_cr()
    if vim.fn.getcmdtype() == ":" and vim.fn.getcmdline():match("^%s*w!!%s*$") then
        return "<C-e><C-u>PiWriteSteer<CR>"
    end
    return "<CR>"
end

-- ---------------------------------------------------------------- agent edits

local function conflict_msg(buf)
    local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":~:.")
    return "changed " .. name .. " — :PiDiff compares, :e! takes pi's version"
end

local function mark_conflict(buf)
    if not vim.b[buf].pi_fleet_conflict then
        vim.b[buf].pi_fleet_conflict = true
        notify(conflict_msg(buf), vim.log.levels.WARN)
    end
    vim.cmd.redrawstatus({ bang = true })
end

local function on_file_changed_shell(args)
    local buf = args.buf
    local reason = vim.v.fcs_reason
    if reason == "deleted" then
        vim.v.fcs_choice = ""
        notify(vim.fn.fnamemodify(args.file, ":~:.") .. " was deleted on disk", vim.log.levels.WARN)
    elseif vim.bo[buf].modified then
        vim.v.fcs_choice = ""
        mark_conflict(buf)
    elseif reason == "mode" or reason == "time" then
        vim.v.fcs_choice = ""
    else
        vim.v.fcs_choice = "reload"
    end
end

local function views_of(buf)
    local saved = {}
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_buf(win) == buf then
            saved[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
        end
    end
    return saved
end

local function restore_views(saved)
    for win, view in pairs(saved) do
        if vim.api.nvim_win_is_valid(win) then
            vim.api.nvim_win_call(win, function()
                vim.fn.winrestview(view)
            end)
        end
    end
end

local function find_buf(path)
    local want = realpath(path)
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(buf) and is_file_buf(buf) then
            local name = vim.api.nvim_buf_get_name(buf)
            if name == path or name == want or realpath(name) == want then
                return buf
            end
        end
    end
end

--- The bytes a write of `buf` would put on disk (approximately: no encoding conversion).
local function buf_text(buf)
    local nl = vim.bo[buf].fileformat == "dos" and "\r\n" or (vim.bo[buf].fileformat == "mac" and "\r" or "\n")
    local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), nl)
    if vim.bo[buf].eol or vim.bo[buf].fixeol then
        text = text .. nl
    end
    if vim.bo[buf].bomb then
        text = "\239\187\191" .. text
    end
    return text
end

local function check_buf(buf)
    local disk = read_file(vim.api.nvim_buf_get_name(buf))
    if vim.bo[buf].modified then
        -- disk may or may not differ; only a real change is a conflict
        if disk == nil or disk ~= buf_text(buf) then
            mark_conflict(buf)
        end
        return
    end
    local views = views_of(buf)
    if disk ~= nil and disk ~= buf_text(buf) then
        -- Compare contents, not just mtime/size: on filesystems with 1 s mtime (Lustre) a
        -- same-size change within the same second is invisible to :checktime.
        pcall(vim.api.nvim_buf_call, buf, function()
            vim.cmd("silent! edit!")
        end)
    else
        pcall(vim.cmd, "silent! checktime " .. buf)
    end
    restore_views(views)
end

--- pi edited these files (absolute paths). Reload unmodified buffers, mark modified ones.
--- Returns the number of open buffers it looked at.
function M.agent_changed(paths)
    local n = 0
    if type(paths) == "string" then
        paths = { paths }
    end
    for _, path in ipairs(paths or {}) do
        if type(path) == "string" and path ~= "" then
            local buf = find_buf(path)
            if buf then
                n = n + 1
                check_buf(buf)
            end
        end
    end
    vim.cmd.redrawstatus({ bang = true })
    return n
end

--- Check every buffer against disk (after a run, for edits made through bash).
function M.checktime_all()
    local views = {}
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    end
    pcall(vim.cmd, "silent! checktime")
    restore_views(views)
    vim.cmd.redrawstatus({ bang = true })
    return true
end

-- ---------------------------------------------------------------- winbar

function M.winbar()
    local buf = vim.api.nvim_get_current_buf()
    if not is_file_buf(buf) then
        return ""
    end
    if vim.b[buf].pi_fleet_conflict then
        return "%#WarningMsg#pi ▸ pi changed this file · :PiDiff compares · :e! takes pi's version%*"
    end
    if vim.bo[buf].modified then
        return "pi ▸ modified · :w! tells pi with your next message · :w!! tells it now"
    end
    return "pi ▸ read-only · :w! save + note · :w!! save + interrupt · :PiHelp"
end

local WINBAR = "%{%v:lua.require'nvconf.pi_fleet'.winbar()%}"

local function refresh_winbar(win)
    if not vim.api.nvim_win_is_valid(win) then
        return
    end
    local floating = vim.api.nvim_win_get_config(win).relative ~= ""
    local want = (not floating and is_file_buf(vim.api.nvim_win_get_buf(win))) and WINBAR or ""
    local have = vim.wo[win].winbar
    if have ~= want and (want ~= "" or have == WINBAR) then
        vim.wo[win].winbar = want
    end
end

-- ---------------------------------------------------------------- commands

local HELP = [[
pi-fleet: this nvim is paired with the pi on its left
======================================================

Files open READ-ONLY here, so a stray edit never reaches pi. Writing tells pi:

  :w!     save + note       pi gets your diff with your next message.
                            If pi is working on this very file, it gets it before
                            its next step instead.
  :w!!    save + interrupt  pi gets your diff now (a steer): it lands after the
                            tool call that is running and before pi's next step.
                            It never aborts a running command.

After every write the buffer is read-only again. Writes with no changes are not sent.
Plain :w fails on purpose (E45: 'readonly' option is set).

When pi edits a file that is open here:
  - unmodified buffer   reloads silently, keeping your view;
  - modified buffer     is NOT reloaded. The winbar turns into a warning:
      :PiDiff   compare your buffer with pi's version on disk (q closes)
      :e!       drop your changes and take pi's version
      :w!       keep yours (pi is told what you changed relative to its version)

Other commands:
  :PiFocus        back to the pi (in the deck: the pi beside this nvim; also C-l)
  :PiWriteSteer   what :w!! runs (accepts a file name)
  :PiHelp         this help

Outside pi-fleet (no $PI_FLEET_SESSION) none of this is active.
Design: ~/env/docs/pi-fleet-design.md §11
]]

function M.help()
    vim.cmd("botright new")
    local buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    pcall(vim.api.nvim_buf_set_name, buf, "pi-fleet://help")
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(HELP, "\n", { plain = true }))
    vim.bo[buf].modifiable = false
    vim.bo[buf].filetype = "markdown"
    vim.api.nvim_win_set_height(0, math.min(#vim.split(HELP, "\n") + 1, vim.o.lines - 4))
    vim.keymap.set("n", "q", "<cmd>close<CR>", { buffer = buf, nowait = true, silent = true })
end

function M.diff()
    local buf = vim.api.nvim_get_current_buf()
    if not is_file_buf(buf) then
        notify(":PiDiff works in a file buffer", vim.log.levels.WARN)
        return
    end
    local path = vim.api.nvim_buf_get_name(buf)
    local disk = read_file(path)
    if disk == nil then
        notify("no readable file on disk for " .. vim.fn.fnamemodify(path, ":~:."), vim.log.levels.WARN)
        return
    end
    local ft = vim.bo[buf].filetype
    local orig = vim.api.nvim_get_current_win()
    vim.cmd("vertical new")
    local scratch = vim.api.nvim_get_current_buf()
    vim.bo[scratch].buftype = "nofile"
    vim.bo[scratch].bufhidden = "wipe"
    vim.bo[scratch].swapfile = false
    local lines = vim.split(disk, "\n", { plain = true })
    if lines[#lines] == "" then
        table.remove(lines)
    end
    vim.api.nvim_buf_set_lines(scratch, 0, -1, false, lines)
    pcall(vim.api.nvim_buf_set_name, scratch, "pi-fleet://disk/" .. path)
    vim.bo[scratch].modifiable = false
    vim.bo[scratch].filetype = ft
    vim.cmd("diffthis")
    vim.api.nvim_win_call(orig, function()
        vim.cmd("diffthis")
    end)
    vim.keymap.set("n", "q", "<cmd>close<CR>", { buffer = scratch, nowait = true, silent = true })
    vim.api.nvim_create_autocmd("BufWipeout", {
        buffer = scratch,
        once = true,
        callback = function()
            if vim.api.nvim_win_is_valid(orig) then
                vim.api.nvim_win_call(orig, function()
                    vim.cmd("diffoff")
                end)
            end
        end,
    })
    notify("left: pi's version on disk · right: your buffer · q closes · :e! takes pi's · :w! keeps yours")
end

--- :PiFocus — back to the pi. In the pi deck ($PI_FLEET_DECK=1) this nvim sits in the nvim slot
--- and its pi in the pi slot beside it, so the pi's pane is just focused (`C-l` and `prefix e` do
--- the same); elsewhere the pi's window and pane are selected.
function M.focus()
    local pane = env("PI_FLEET_PI_PANE")
    if not pane or not pane:match("^%%%d+$") then
        notify("no pi pane ($PI_FLEET_PI_PANE)", vim.log.levels.WARN)
        return false
    end
    if not env("TMUX") then
        notify("not inside tmux", vim.log.levels.WARN)
        return false
    end
    local cmd = { "tmux", "select-window", "-t", pane, ";", "select-pane", "-t", pane }
    if env("PI_FLEET_DECK") == "1" then
        cmd = { "tmux", "select-pane", "-t", pane }
    end
    vim.system(cmd, { text = true },
        function(res)
            if res.code ~= 0 then
                vim.schedule(function()
                    notify("tmux: " .. vim.trim(res.stderr or ""), vim.log.levels.WARN)
                end)
            end
        end)
    return true
end

-- ---------------------------------------------------------------- setup

local function cmap_is_ours()
    local m = vim.fn.maparg("<CR>", "c", false, true)
    return type(m) == "table" and m.desc == CMAP_DESC
end

function M.setup()
    if not M.paired() or M._setup then
        return
    end
    M._setup = true

    local existing = vim.fn.maparg("<CR>", "c", false, true)
    if type(existing) == "table" and existing.lhs and not cmap_is_ours() then
        notify("another cmdline <CR> mapping exists; :w!! overrides it", vim.log.levels.WARN)
    end
    vim.keymap.set("c", "<CR>", M.cmdline_cr, { expr = true, desc = CMAP_DESC })

    local group = vim.api.nvim_create_augroup("pi_fleet", { clear = true })
    vim.api.nvim_create_autocmd({ "BufReadPost", "BufNewFile" }, {
        group = group,
        callback = function(args)
            if is_file_buf(args.buf) then
                vim.bo[args.buf].readonly = true
                vim.b[args.buf].pi_fleet_conflict = nil
            end
        end,
    })
    vim.api.nvim_create_autocmd("BufWritePre", { group = group, callback = before_write })
    vim.api.nvim_create_autocmd("BufWritePost", { group = group, callback = after_write })
    vim.api.nvim_create_autocmd("FileChangedShell", { group = group, callback = on_file_changed_shell })
    vim.api.nvim_create_autocmd({ "BufWinEnter", "WinEnter", "FileType", "BufFilePost", "TermOpen" }, {
        group = group,
        callback = function()
            refresh_winbar(vim.api.nvim_get_current_win())
        end,
    })
    vim.api.nvim_create_autocmd("VimEnter", {
        group = group,
        once = true,
        callback = function()
            for _, win in ipairs(vim.api.nvim_list_wins()) do
                refresh_winbar(win)
            end
            if not cmap_is_ours() then
                notify("a plugin replaced the cmdline <CR> mapping: :w!! will not reach pi", vim.log.levels.WARN)
            end
        end,
    })
    vim.api.nvim_create_autocmd("BufWipeout", {
        group = group,
        callback = function(args)
            pending[args.buf] = nil
        end,
    })

    vim.api.nvim_create_user_command("PiWriteSteer", M.write_steer,
        { nargs = "?", complete = "file", desc = "save and interrupt pi (:w!!)" })
    vim.api.nvim_create_user_command("PiHelp", M.help, { desc = "pi-fleet: how this nvim talks to pi" })
    vim.api.nvim_create_user_command("PiDiff", M.diff, { desc = "pi-fleet: compare buffer with disk" })
    vim.api.nvim_create_user_command("PiFocus", M.focus, { desc = "pi-fleet: jump to the pi pane" })
end

return M
