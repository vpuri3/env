--
-- line-number
vim.opt.nu = true
vim.opt.relativenumber = true

-- tabstop
vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true

-- panes
vim.opt.splitbelow = true
vim.opt.splitright = true

-- search
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.hlsearch = true
vim.opt.incsearch = true

-- undo
--vim.opt.swapfile = false
--vim.opt.backup = false
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
vim.opt.undofile = true

-- colors
vim.opt.termguicolors = true
vim.opt.colorcolumn = "80"

-- misc
vim.opt.autochdir = true
vim.opt.guicursor = ""

vim.opt.smartindent = true
vim.opt.wrap = false
vim.opt.scrolloff = 8
vim.opt.updatetime = 50

vim.opt.signcolumn = "yes"
vim.opt.isfname:append("@-@")

--
