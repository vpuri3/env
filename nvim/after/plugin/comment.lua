--
if vim.g.vscode then
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
