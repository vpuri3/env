--
-- Modes
--   normal_mode = "n",
--   insert_mode = "i",
--   visual_mode = "v",
--   visual_block_mode = "x",
--   term_mode = "t",
--   command_mode = "c",

-- TODO: "=" for fixing indenting

local opts = {
    noremap = true,
    silent = true,
}

-- map vscode comments to  '<leader>c'
if vim.g.vscode then
    vim.keymap.set({'n', 'v', 'x'}, '<leader>c', function()
        vim.fn.VSCodeNotify('editor.action.commentLine')
        -- add <ESC> here
    end, opts)

else
    -- taken care of by comment package
end

-- open file explorer with <leader>e
if vim.g.vscode then
    vim.cmd([[
        command! -nargs=0 ToggleSidebar call VSCodeNotify("workbench.action.toggleSidebarVisibility")
        command! -nargs=0 SelectCurrentFileInSidebar call VSCodeNotify("workbench.view.explorer")
    ]])

    vim.keymap.set("n", "<leader>e", function()
        vim.cmd("ToggleSidebar")
    end , opts)
else
    vim.keymap.set("n", "<leader>e", vim.cmd.Ex, opts)
end

-- fuzzy finding
if vim.g.vscode then
    -- vim.keymap.set("n", "<leader>f", ":e<CR>", opts)
    vim.keymap.set("n", "<leader>f", function()
        vim.fn.VSCodeNotify('workbench.action.quickOpen')
    end, opts)
else
    -- taken care of by nvim.telescope
end

if vim.g.vscode then
    -- toggle terminal with <leader>r
    vim.cmd([[
        command! -nargs=0 FocusTerminal call VSCodeNotify("workbench.action.terminal.focus")
        command! -nargs=0 ToggleTerminal call VSCodeNotify("workbench.action.terminal.toggleTerminal")
    ]])
    vim.keymap.set("n", "<leader>r", ":FocusTerminal<CR>", opts)
    -- vim.keymap.set("n", "<leader>r", ":ToggleTerminal<CR>", opts) -- failing

    -- toggle AI sidebar (does not work)
    -- vim.keymap.set("n", "<leader>t", ":call VSCodeNotify('workbench.action.toggleAI')<CR>", opts)
else
    --
end

-- copy-paste hacks
vim.keymap.set("n", "Y", "y$", opts) -- yank from cursor to line
vim.keymap.set({"n", "v", "x"}, "<leader>y", [["+y]], opts) -- yank to system clipboard register ("+)
vim.keymap.set({"n", "v", "x"}, "<leader>P", [["+p]], opts) -- paste from system clipboard
vim.keymap.set({"v", "x"}, "<leader>p", [["_dp]], opts) -- delete to void register and paste from system clipboard (this maintains the latest register state)
vim.keymap.set({"n", "v", "x"}, "<leader>d", [["_d]], opts) -- delete to void register

if vim.g.vscode then
    -- parantheses autocompletions are taken care of by vscode
    --
    -- quotes are also taken care of by vscode except ``
    -- in vscode settings.json
    -- --
    -- "editor.quickSuggestions": {
    --     "other": true,
    --     "comments": true,
    --     "strings": true
    -- },
    -- "editor.suggest.snippetsPreventQuickSuggestions": false,
    
    -- "editor.autoClosingPairs": [
    --     {
    --         "open": "`",
    --         "close": "`",
    --         "notIn": ["string", "comment"]
    --     }
    -- ],

    -- triple quotes are not handled by vscode
    -- neither is <>
    
else
    -- parantheses
    vim.keymap.set("i", "(", "()<Left>", opts)
    vim.keymap.set("i", "[", "[]<Left>", opts)
    vim.keymap.set("i", "{", "{}<Left>", opts)

    vim.keymap.set("i", "(<CR>", "(<CR>)<ESC>O", opts)
    vim.keymap.set("i", "[<CR>", "[<CR>]<ESC>O", opts)
    vim.keymap.set("i", "{<CR>", "{<CR>}<ESC>O", opts)
    
    vim.keymap.set("i", "<>", "<><Left>", opts)

    -- quotes
    vim.api.nvim_set_keymap("i", '"', '""<Left>', opts) -- double quotes "
    vim.api.nvim_set_keymap("i", "'", "''<Left>", opts) -- single quotes '
    vim.api.nvim_set_keymap("i", "`", "``<Left>", opts) -- math quotes `

    vim.api.nvim_set_keymap("i", '"""', [[""""""<Esc>hhi<CR><Esc>O]], opts)
    vim.api.nvim_set_keymap("i", "'''", [[''''''<Esc>hhi<CR><Esc>O]], opts)
    vim.api.nvim_set_keymap("i", "```", [[``````<Esc>hhi<CR><Esc>O]], opts)
end

-- Visual mode
-- move highlighted blocks around
vim.keymap.set({"v", "x"}, "J", ":move '>+1<CR>gv=gv", opts)
vim.keymap.set({"v", "x"}, "K", ":move '<-2<CR>gv=gv", opts)

-- Stay in indent mode
vim.keymap.set("v", "<", "<gv", opts)
vim.keymap.set("v", ">", ">gv", opts)

---- split screen motions
if vim.g.vscode then
    vim.keymap.set('n', '<C-h>', function() vim.fn.VSCodeNotify('workbench.action.focusLeftGroup') end, opts)
    vim.keymap.set('n', '<C-j>', function() vim.fn.VSCodeNotify('workbench.action.focusBelowGroup') end, opts)
    vim.keymap.set('n', '<C-k>', function() vim.fn.VSCodeNotify('workbench.action.focusAboveGroup') end, opts)
    vim.keymap.set('n', '<C-l>', function() vim.fn.VSCodeNotify('workbench.action.focusRightGroup') end, opts)

else
    vim.keymap.set("n", "<C-H>", "<C-W><C-H>", opts)
    vim.keymap.set("n", "<C-J>", "<C-W><C-J>", opts)
    vim.keymap.set("n", "<C-K>", "<C-W><C-K>", opts)
    vim.keymap.set("n", "<C-L>", "<C-W><C-L>", opts)
end

-- vim.keymap.set("x", "<C-i>", ":normal! >gv<CR>", opts)

if vim.g.vscode then
    
    -- vim.keymap.set("n", "<C-p>", function() vim.fn.VSCodeNotify('workbench.action.previousEditor') end, opts)
    -- vim.keymap.set("n", "<C-p>", function() vim.fn.VSCodeNotify('workbench.action.nextEditor') end, opts)

    -- {
    --     "key": "ctrl+p",
    --     "command": "workbench.action.previousEditor",
    --     "when": "editorTextFocus && neovim.mode == 'normal'"
    -- },

    -- {
    --     "key": "ctrl+n",
    --     "command": "workbench.action.nextEditor",
    --     "when": "editorTextFocus && neovim.mode == 'normal'"
    -- },
    --

    -- -- close this buffer
    -- vim.keymap.set("n", ":bd", function() vim.fn.VSCodeNotify('workbench.action.closeActiveEditor') end, opts)

else
    -- Navigate open buffers within a tab (taken care of in keybindings.json)
    vim.keymap.set("n", "<S-l>", ":bnext<CR>", opts)
    vim.keymap.set("n", "<S-h>", ":bprevious<CR>", opts)
end

-- terminal
vim.keymap.set("n", ":TT", ":tabe<CR>:terminal<CR>i", opts)
vim.api.nvim_set_keymap("t", "<Esc>", [[<C-\><C-N>]], opts)

-- misc
vim.keymap.set("n", "<Esc><Esc>", "<Esc>:noh<CR>", opts)
--