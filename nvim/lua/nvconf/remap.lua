--
vim.g.mapleader = " "

vim.keymap.set("n", "<leader>e", vim.cmd.Ex)

-- move highlighted blocks around
vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

-- maintain cursor position
vim.keymap.set("n", "<C-D>", "<C-D>zz")
vim.keymap.set("n", "<C-U>", "<C-U>zz")
--vim.keymap.set("n", "n", "nzzv")
--vim.keymap.set("n", "N", "nzzv")

-- copy-paste hacks

-- paste and move pasted over stuff to void register
vim.keymap.set("x", "<leader>p", "\"_dp")

-- yank to system clipboard register
vim.keymap.set({"n", "v"}, "<leader>y", [[\"+y]])
vim.keymap.set("n", "<leader>Y", [[\"+Y]])

-- delete to void register
vim.keymap.set({"n", "v"}, "<leader>d", [["_d]])

-- parantheses
vim.keymap.set("i", "(", "()<left>")
vim.keymap.set("i", "[", "[]<left>")
vim.keymap.set("i", "{", "{}<left>")

-- quotes
vim.api.nvim_set_keymap("i", '""', [[""<Esc>i]], { noremap = true })
vim.api.nvim_set_keymap("i", "''", [[''<Esc>i]], { noremap = true })
vim.api.nvim_set_keymap("i", "<>", [[<><Esc>i]], { noremap = true })

vim.keymap.set("i", "{<CR>", "{<CR>}<ESC>O") -- TODO doesn't work

-- split screen motions
vim.keymap.set("n", "<C-H>", "<C-W><C-H>")
vim.keymap.set("n", "<C-J>", "<C-W><C-J>")
vim.keymap.set("n", "<C-K>", "<C-W><C-K>")
vim.keymap.set("n", "<C-L>", "<C-W><C-L>")

-- tabs motions
vim.keymap.set("n", ":T", ":tabe")
vim.keymap.set("n", "<C-P>", ":tabp<CR>")
vim.keymap.set("n", "<C-N>", ":tabn<CR>")

-- terminal
vim.keymap.set("n", ":TT", ":tabe<CR>:terminal<CR>i")
vim.api.nvim_set_keymap("t", "<Esc>", [[<C-\><C-N>]], { noremap = true })

-- misc
vim.keymap.set("n", "Y", "y$")
vim.keymap.set("n", "<Esc><Esc>", ":<Esc><Esc>noh<CR>")

--
