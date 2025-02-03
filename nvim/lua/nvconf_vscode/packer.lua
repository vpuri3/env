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

    -- use 'nvim-telescope/telescope.nvim'

    -- bye bye Telescope, Treesitter, Undotree
    
    -- Enhanced text objects and motions
    -- use 'tpope/vim-surround'              -- Surround text objects
    -- use 'tpope/vim-repeat'                -- Better command repeating
    -- use 'wellle/targets.vim'              -- Additional text objects
    -- use 'michaeljsmith/vim-indent-object' -- Indent text objects
    -- use 'bkad/CamelCaseMotion'            -- CamelCase word motions
    
    -- -- Enhanced jumping/searching
    -- use {
    --     'phaazon/hop.nvim',               -- Easy motion-style jumping
    --     branch = 'v2'
    -- }
    
    -- -- Optional but useful
    -- use 'vim-scripts/ReplaceWithRegister' -- Quick replace with register

    if PACKER_BOOTSTRAP then
        require('packer').sync()
    end

end)
