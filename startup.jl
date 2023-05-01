#
"""
 to run file `script.jl`, do
 ```julia
 @run script
 ```

 TODO:
 -add completion support
"""

#= # @run conflicts with Debugger.jl
macro run(file)
    fs = String(file)
    fn = fs * ".jl"
    return :(include($fn))
end
=#

"""
macro for adding test dependencies to environment path
"""

# add dependencies to env stack
#=
let
    # add dependencies to env stack
    pkgpath = dirname(dirname(pathof(PDEInterfaces)))
    tstpath = joinpath(pkgpath, "test")
    !(tstpath in LOAD_PATH) && push!(LOAD_PATH, tstpath)
    nothing
end
=#

# utility
ls(x) = readdir(x)
ls()  = readdir()
ty(x) = typeof(x)
fn(x) = fieldnames(x)
fnty  = fn ∘ ty

push(x::Tuple, val) = (x..., val)

# TODO make macro @capture_out include("script.jl")
function capture_out(script::AbstractString)
    open(script * ".stdout", "w") do io
        redirect_stdout(io) do
            include(script * ".jl")
        end
    end
end

