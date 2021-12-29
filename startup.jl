#
macro run(file)
    fs = String(file)
    fn = fs * ".jl"
    return :(include($fn))
end

