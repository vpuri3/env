--
if not vim.g.vscode then
    if vim.treesitter and vim.treesitter.language then
        if vim.treesitter.language.ft_to_lang == nil and vim.treesitter.language.get_lang ~= nil then
            vim.treesitter.language.ft_to_lang = vim.treesitter.language.get_lang
        end
    end

    require('telescope').setup{
        defaults = {
            initial_mode = "insert",
            file_ignore_patterns = {
                "^.git/",
                "^node_modules/",
                "^dist/",
                "^build/",
                "^target/",
                "^coverage/",
                "^__pycache__/",
                "^.pytest_cache/",
                "^.mypy_cache/",
                "^.ruff_cache/",
                "^.tox/",
                "^.nox/",
                "^.cache/",
                "^.venv/",
                "^venv/",
                "^.next/",
                "^.nuxt/",
                "^.idea/",
                "^.ipynb_checkpoints/",
                "^wandb/",
            },
            vimgrep_arguments = {
                "rg",
                "-L",
                "--hidden",
                "--color=never",
                "--no-heading",
                "--with-filename",
                "--line-number",
                "--column",
                "--smart-case",
                "--glob",
                "!.git/*",
                "--glob",
                "!node_modules/*",
                "--glob",
                "!dist/*",
                "--glob",
                "!build/*",
                "--glob",
                "!target/*",
                "--glob",
                "!coverage/*",
                "--glob",
                "!__pycache__/*",
                "--glob",
                "!.pytest_cache/*",
                "--glob",
                "!.mypy_cache/*",
                "--glob",
                "!.ruff_cache/*",
                "--glob",
                "!.tox/*",
                "--glob",
                "!.nox/*",
                "--glob",
                "!.cache/*",
                "--glob",
                "!.venv/*",
                "--glob",
                "!venv/*",
                "--glob",
                "!.next/*",
                "--glob",
                "!.nuxt/*",
                "--glob",
                "!.idea/*",
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
        preview = {
            treesitter = true,
        },
        pickers = {},
        extensions = {
        }
    }


    local builtin = require('telescope.builtin')

    vim.keymap.set('n', '<leader>ff', function()
        local opts = {
            show_untracked = true,
            file_ignore_patterns = {
                ".*/legacy/training/exp/",
                "^legacy/training/exp/",
                "legacy/training/exp/",
                ".*/.venv/",
                "^.venv/",
                ".venv/",
                ".*/venv/",
                "^venv/",
                "venv/",
                ".*/wandb/",
                "^wandb/",
                "wandb/",
            },
        }

        local ok = pcall(builtin.git_files, opts)
        if not ok then
            builtin.find_files(vim.tbl_extend("force", opts, { hidden = true }))
        end
    end, {})
    vim.keymap.set('n', '<leader>fg', builtin.git_files, {})
    vim.keymap.set('n', '<leader>fb', builtin.buffers, {})
    vim.keymap.set('n', '<leader>fh', builtin.commands, {})

    --vim.keymap.set('n', '<leader>fs', builtin.live_grep, {})
    vim.keymap.set('n', '<leader>fs', function()
        builtin.grep_string({search = vim.fn.input("Grep > ")});
    end)
end
