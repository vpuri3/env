--
local servers = {
    "lua_ls",
    --"pyright",
    "clangd",
    "julials",
}

local settings = {
    ui = {
        border = "none",
        icons = {
            package_installed = "◍",
            package_pending = "◍",
            package_uninstalled = "◍",
        },
    },
    log_level = vim.log.levels.INFO,
    max_concurrent_installers = 4,
}

require("mason").setup(settings)
require("mason-lspconfig").setup({
    ensure_installed = servers,
    automatic_installation = true,
})

--
-- Server specific options
--

local status, lspconfig = pcall(require, "lspconfig")
if not status then
    vim.notify("lspconfig not found")
	return
end

local opts = {}

for _, server in pairs(servers) do
	opts = {
		on_attach = require("nvconf.lsp.handlers").on_attach,
		capabilities = require("nvconf.lsp.handlers").capabilities,
	}

	server = vim.split(server, "@")[1]

	local require_ok, conf_opts = pcall(require, "nvconf.lsp.settings." .. server)
	if require_ok then
		opts = vim.tbl_deep_extend("force", conf_opts, opts)
	end

	lspconfig[server].setup(opts)
end
