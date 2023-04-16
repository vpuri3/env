--
-- :help options

-- leader
vim.g.mapleader = " "

-- line-number
vim.opt.nu = true
vim.opt.relativenumber = true
vim.opt.numberwidth = 4 -- width of line-number column

-- tabstop
vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true

vim.opt.showtabline = 2

-- panes
vim.opt.splitbelow = true
vim.opt.splitright = true

-- search
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.hlsearch = true
vim.opt.incsearch = true

-- undo
vim.opt.swapfile = true
vim.opt.backup = false
vim.opt.undofile = true
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"

-- colors
vim.opt.termguicolors = true
vim.opt.colorcolumn = "80"

-- timeout
vim.opt.timeoutlen = 1000 -- time to wait for a mapped sequence to complete (ms)
vim.opt.ttimeoutlen = 0

-- path
-- vim.opt.autochdir = true
-- vim.cmd "set path+=**"

-- misc
vim.opt.guicursor = ""
vim.opt.fileencoding = "utf-8"

vim.opt.smartindent = true
vim.opt.wrap = false
vim.opt.scrolloff = 8
vim.opt.updatetime = 50

vim.opt.signcolumn = "yes"
vim.opt.isfname:append("@-@")
vim.cmd [[set iskeyword+=-]] -- treat "-" as part of the word

--
