--
--print("loading nvim/lua/nvconf")

require("nvconf.remap")
require("nvconf.set")

require("nvconf.packer")
require("nvconf.colors")
require("nvconf.cmp")
require("nvconf.lsp")


-- paired with a pi (in the pi deck, or split beside a pi started by hand): `pi-fleet pair` sets PI_FLEET_SESSION and
-- PI_FLEET_CTL_SOCK. The agent's bash commands inherit PI_FLEET_SESSION only, and an nvim
-- nested in another nvim's terminal has $NVIM: neither is paired. Same check as
-- require("nvconf.pi_fleet").paired(), inline so unpaired nvims never load the module.
if (vim.env.PI_FLEET_SESSION or "") ~= "" and (vim.env.PI_FLEET_CTL_SOCK or "") ~= "" and (vim.env.NVIM or "") == "" then
    require("nvconf.pi_fleet").setup()
end
