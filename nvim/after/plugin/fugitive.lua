if vim.g.vscode then
else
    vim.keymap.set("n", "<leader>gs", vim.cmd.Git)
end