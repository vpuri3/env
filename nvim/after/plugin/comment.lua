--
if vim.g.vscode then
elseif not pcall(require, 'nvim_comment') then
    vim.notify("nvim-comment is not installed; run :PackerInstall", vim.log.levels.WARN)
else
    require('nvim_comment').setup({
        -- Should key mappings be created
        create_mappings = true,
        -- Normal mode mapping left hand side
        line_mapping = "<leader>cc",
        -- Visual/Operator mapping left hand side
        operator_mapping = "<leader>c",
    })
end
