--

-- Modes
--   normal_mode = "n",
--   insert_mode = "i",
--   visual_mode = "v",
--   visual_block_mode = "x",
--   term_mode = "t",
--   command_mode = "c",

local opts = {
    noremap = true,
    silent = true,
}

vim.g.mapleader = " "

vim.keymap.set("n", "<leader>e", vim.cmd.Ex, opts)

-- maintain cursor position
vim.keymap.set("n", "<C-D>", "<C-D>zz", opts)
vim.keymap.set("n", "<C-U>", "<C-U>zz", opts)
-- vim.keymap.set("n", "N", "Nzz", opts)
-- vim.keymap.set("n", "n", "nzz", opts)

-- copy-paste hacks

-- paste and move pasted over stuff to void register
vim.keymap.set("x", "<leader>p", "\"_dp", opts)

-- yank to system clipboard register
vim.keymap.set({"n", "v"}, "<leader>y", [[\"+y]], opts)
vim.keymap.set("n", "<leader>Y", [[\"+Y]], opts)

-- delete to void register
vim.keymap.set({"n", "v"}, "<leader>d", [["_d]], opts)

-- parantheses
vim.keymap.set("i", "(", "()<left>", opts)
vim.keymap.set("i", "[", "[]<left>", opts)
vim.keymap.set("i", "{", "{}<left>", opts)

vim.api.nvim_set_keymap("i", "<>", [[<><Esc>i]], opts)

vim.keymap.set("i", "(<CR>", "(<CR>)<ESC>O", opts)
vim.keymap.set("i", "[<CR>", "[<CR>]<ESC>O", opts)
vim.keymap.set("i", "{<CR>", "{<CR>}<ESC>O", opts)

-- quotes
vim.api.nvim_set_keymap("i", '""', [[""<Esc>i]], opts)
vim.api.nvim_set_keymap("i", "''", [[''<Esc>i]], opts)
vim.api.nvim_set_keymap("i", "``", [[``<Esc>i]], opts)

vim.api.nvim_set_keymap("i", '"""', [[""""""<Esc>hhi<CR><Esc>O]], opts)
vim.api.nvim_set_keymap("i", "'''", [[''''''<Esc>hhi<CR><Esc>O]], opts)
vim.api.nvim_set_keymap("i", "```", [[``````<Esc>hhi<CR><Esc>O]], opts)

-- Visual mode
-- move highlighted blocks around
vim.keymap.set({"v", "x"}, "J", ":move '>+1<CR>gv=gv", opts)
vim.keymap.set({"v", "x"}, "K", ":move '<-2<CR>gv=gv", opts)

-- Stay in indent mode
vim.keymap.set("v", "<", "<gv", opts)
vim.keymap.set("v", ">", ">gv", opts)

-- split screen motions
vim.keymap.set("n", "<C-H>", "<C-W><C-H>", opts)
vim.keymap.set("n", "<C-J>", "<C-W><C-J>", opts)
vim.keymap.set("n", "<C-K>", "<C-W><C-K>", opts)
vim.keymap.set("n", "<C-L>", "<C-W><C-L>", opts)

-- Navigate buffers
vim.keymap.set("n", "<S-l>", ":bnext<CR>", opts)
vim.keymap.set("n", "<S-h>", ":bprevious<CR>", opts)

-- tabs motions
vim.keymap.set("n", ":T", ":tabe", opts)
vim.keymap.set("n", "<C-P>", ":tabp<CR>", opts)
vim.keymap.set("n", "<C-N>", ":tabn<CR>", opts)

-- terminal
vim.keymap.set("n", ":TT", ":tabe<CR>:terminal<CR>i", opts)
vim.api.nvim_set_keymap("t", "<Esc>", [[<C-\><C-N>]], opts)

-- misc
vim.keymap.set("n", "Y", "y$", opts)
vim.keymap.set("n", "<Esc><Esc>", "<Esc>:noh<CR>", opts)
--
