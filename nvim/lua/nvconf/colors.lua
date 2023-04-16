--
function SetColor(color)
	--color = color or "murphy"
	color = color or "tokyonight-night"

    local status, _ = pcall(vim.cmd.colorscheme, color)
    if not status then
        vim.notify("colorscheme " .. color .. " not found.")
    end

	vim.api.nvim_set_hl(0, "Normal", {bg = "none"})
	vim.api.nvim_set_hl(0, "NormalFloat", {bg = "none"})
end

SetColor()
