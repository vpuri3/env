--

-- disable default file explorer (netrw)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- enable highlight groups (done in nfconf/set.lua)
--vim.opt.termguicolors = true

require("nvim-tree").setup({
    sort_by = "case_sensitive",

    filters = {
        dotfiles = false,
        exclude = {},
    },

    disable_netrw = true,
    hijack_netrw = true,
    hijack_cursor = true,
    hijack_unnamed_buffer_when_opening = true,
    sync_root_with_cwd = true,

    update_focused_file = {
        enable = true,
        update_root = false,
    },

    view = {
        adaptive_size = false,
        side = "left",
        width = 30,
        preserve_window_proportions = true,
    },

    git = {
        enable = true,
        ignore = false,
    },

    filesystem_watchers = {
        enable = true,
    },

    actions = {
        open_file = {
            resize_window = true,
        }
    },

    renderer = {
        root_folder_label = true,
        highlight_git = true,
        highlight_opened_files = "none",

        indent_markers = {
            enable = true,
        },
        icons = {
            show = {
                file = true,
                folder = true,
                folder_arrow = true,
                git = true,
            },
        }
    }
})

vim.keymap.set("n", "<leader>e", ":NvimTreeToggle<CR>")

-- TODO
-- open file in split
-- open file in new tab
