--
-- :help options

-- leader
vim.g.mapleader = " "

local options = {

    -- line-number
    nu = true,
    relativenumber = false,
    numberwidth = 4, -- width of line-number column

    -- tabstop
    tabstop = 4,
    softtabstop = 4,
    shiftwidth = 4,
    expandtab = false,

    showtabline = 2,

    -- panes
    splitbelow = true,
    splitright = true,

    -- search
    ignorecase = true,
    smartcase = true,
    hlsearch = true,
    incsearch = true,

    -- undo
    swapfile = true,
    backup = false,
    undofile = true,
    undodir = os.getenv("HOME") .. "/.vim/undodir",

    -- colors
    termguicolors = true,
    colorcolumn = "80",

    -- timeout
    timeoutlen = 1000, -- time to wait for a mapped sequence to complete (ms)
    ttimeoutlen = 0,

    -- misc
    guicursor = "",
    fileencoding = "utf-8",

    smartindent = true,
    wrap = false,
    scrolloff = 1,
    updatetime = 50,

    signcolumn = "yes",

}

for k, v in pairs(options) do
    vim.opt[k] = v
end

-- misc

--vim.opt.isfname:append("@-@")
--vim.opt.shortmess:append "c"

-- path
-- vim.opt.autochdir = true
-- vim.cmd "set path+=**"

-- vim.cmd [[set iskeyword+=-]] -- treat "-" as part of the word

--
