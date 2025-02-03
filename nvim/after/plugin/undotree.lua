if not vim.g.vscode then
    --nnoremap <F5> :UndotreeToggle<CR>
    vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle)
end