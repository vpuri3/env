--
--print("loading nvim/lua/nvconf")

require("nvconf.remap")
require("nvconf.set")

require("nvconf.packer")
require("nvconf.colors")
require("nvconf.cmp")
require("nvconf.lsp")


-- paired with a pi in a pi-fleet window (pi-fleet pair sets PI_FLEET_SESSION)
if (vim.env.PI_FLEET_SESSION or "") ~= "" then
    require("nvconf.pi_fleet").setup()
end
