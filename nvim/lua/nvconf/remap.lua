--
vim.g.mapleader = " "

vim.keymap.set("n", "<leader>e", vim.cmd.Ex)

-- parantheses
vim.keymap.set("i", "(", "()<left>")
vim.keymap.set("i", "[", "[]<left>")
vim.keymap.set("i", "{", "{}<left>")

-- quotes
vim.api.nvim_set_keymap("i", '""', [[""<Esc>i]], { noremap = true })
vim.api.nvim_set_keymap("i", "''", [[''<Esc>i]], { noremap = true })

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

--
