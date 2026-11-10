-- nvim-treesitter `main` branch: needs Neovim 0.12+, the tree-sitter CLI and
-- a C compiler. Parsers are installed by bootstrap.sh (or :TSInstall), never
-- at startup, so a machine without a compiler does not retry on every launch.
if vim.g.vscode then
    return
end
if vim.fn.has('nvim-0.12') == 0 then
    vim.notify("treesitter highlighting needs Neovim 0.12+; re-run ~/env/bootstrap.sh", vim.log.levels.WARN)
    return
end
if not pcall(require, 'nvim-treesitter') then
    vim.notify("nvim-treesitter is not installed; run :PackerInstall", vim.log.levels.WARN)
    return
end

vim.g.env_treesitter_parsers = {
    "bash", "make", "markdown", "lua",
    "vim", "vimdoc", "query",
    "julia", "python", "javascript",
    "latex", "bibtex",
    "c", "cpp", "fortran",
    "git_rebase", "gitattributes", "gitcommit", "gitignore",
}

local max_filesize = 100 * 1024 -- 100 KB

vim.api.nvim_create_autocmd('FileType', {
    group = vim.api.nvim_create_augroup('env_treesitter', { clear = true }),
    callback = function(args)
        local stats = vim.uv.fs_stat(vim.api.nvim_buf_get_name(args.buf))
        if stats and stats.size > max_filesize then
            return
        end
        if pcall(vim.treesitter.start, args.buf) then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
        end
    end,
})
