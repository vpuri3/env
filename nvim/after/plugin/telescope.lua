--
if not vim.g.vscode then
    local telescope = require('telescope').setup{
        defaults = {
            vimgrep_arguments = {
                "rg",
                "-L",
                "--color=never",
                "--no-heading",
                "--with-filename",
                "--line-number",
                "--column",
                "--smart-case",
            },

            mappings = {
                i = {
                    ["<C-h>"] = "which_key",
                },
                n = {
                    ["<C-h>"] = "which_key",
                    ["q"] = require("telescope.actions").close,
                    ["<Esc><Esc>"] = require("telescope.actions").close,
                },
            }
        },
        pickers = {
        },
        extensions = {
        }
    }


    local builtin = require('telescope.builtin')

    vim.keymap.set('n', '<leader>ff', builtin.find_files, {})
    vim.keymap.set('n', '<leader>fg', builtin.git_files, {})
    vim.keymap.set('n', '<leader>fb', builtin.buffers, {})
    vim.keymap.set('n', '<leader>fh', builtin.commands, {})

    --vim.keymap.set('n', '<leader>fs', builtin.live_grep, {})
    vim.keymap.set('n', '<leader>fs', function()
        builtin.grep_string({search = vim.fn.input("Grep > ")});
    end)
end

