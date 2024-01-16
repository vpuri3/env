--

-- Automatically install packer
local ensure_packer = function()
    local fn = vim.fn
    local install_path = fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
    if fn.empty(fn.glob(install_path)) > 0 then
        fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
        vim.cmd [[packadd packer.nvim]]
        return true
    end
    return false
end

local PACKER_BOOTSTRAP = ensure_packer()

-- protected call to require packer
local status, packer = pcall(require, "packer")
if not status then
    vim.notify("packer not loaded :/") -- similar to print
    return
end

-- have packer use a popup window
packer.init {
    display = {
        open_fn = function()
            return require("packer.util").float { border = "rounded" }
        end,
    },
}

-- Only required if you have packer configured as `opt`
vim.cmd [[packadd packer.nvim]]

return require('packer').startup(function(use)
    -- Packer can manage itself
    use 'wbthomason/packer.nvim'

    -- TODO - configure telescope
    use {
        'nvim-telescope/telescope.nvim', tag = '0.1.5',
        requires = { {'nvim-lua/plenary.nvim'} }
    }

    use {
        'nvim-treesitter/nvim-treesitter',
        {run = ':TSUpdate'}
    }

    use {
        'nvim-tree/nvim-tree.lua',
        requires = {
            'nvim-tree/nvim-web-devicons', -- optional
        },
        config = function()
            require("nvim-tree").setup {}
        end
    }

    use { 'folke/tokyonight.nvim' } --colorscheme

    use { 'mbbill/undotree' }

    use { 'tpope/vim-fugitive' }

    -- cmp plugins
    use "hrsh7th/nvim-cmp" -- The completion plugin
    use "hrsh7th/cmp-buffer" -- buffer completions
    use "hrsh7th/cmp-path" -- path completions
    use "hrsh7th/cmp-cmdline" -- cmdline completions
    use "saadparwaiz1/cmp_luasnip" -- snippet completions
    use "hrsh7th/cmp-nvim-lsp" -- LSP completions
    use "hrsh7th/cmp-nvim-lua"

    -- snippets
    use "L3MON4D3/LuaSnip" --snippet engine
    use "rafamadriz/friendly-snippets" -- a bunch of snippets to use

    -- LSP
    use "neovim/nvim-lspconfig" -- enable LSP
    use "williamboman/mason.nvim" -- simple to use language server installer
    use "williamboman/mason-lspconfig.nvim" -- simple to use language server installer
    use 'jose-elias-alvarez/null-ls.nvim' -- LSP diagnostics and code actions

    -- use {
    --     'VonHeikemen/lsp-zero.nvim',
    --     branch = 'v2.x',
    --     requires = {
    --         -- LSP Support
    --         {'neovim/nvim-lspconfig'},             -- Required
    --         {                                      -- Optional
    --             'williamboman/mason.nvim',
    --             run = function()
    --                 pcall(vim.cmd, 'MasonUpdate')
    --             end,
    --         },
    --         {'williamboman/mason-lspconfig.nvim'}, -- Optional
    --
    --         -- Autocompletion
    --         {'hrsh7th/nvim-cmp'},     -- Required
    --         {'hrsh7th/cmp-nvim-lsp'}, -- Required
    --         {'L3MON4D3/LuaSnip'},     -- Required
    --     }
    -- }

    use "terrortylor/nvim-comment" -- TODO - update c/cpp comment to //

    -- -- TODO - fix julia-vim
    -- use {
    --     'JuliaEditorSupport/julia-vim',
    --     ft = { 'julia' }
    --     config = function()
    --         require("julia-vim").setup({})
    --     end
    -- }

    -- use "kdheepak/JuliaFormatter.vim" -- TODO

    -- TODO - nvterm/toggleterm, bufferline, cmp, whichkey
    -- TODO - add colors to fugitive

    if PACKER_BOOTSTRAP then
        require('packer').sync()
    end

end)
