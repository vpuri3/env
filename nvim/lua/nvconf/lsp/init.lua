--
local status, _ = pcall(require, "lspconfig")
if not status then
    vim.notify("lspconfig not found")
    return
end

require("nvconf.lsp.mason")
require("nvconf.lsp.handlers").setup()
require("nvconf.lsp.null-ls")
