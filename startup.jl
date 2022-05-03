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
pkgpath = dirname(dirname(@__FILE__))
tstpath = joinpath(pkgpath, "test")
if !(tstpath in LOAD_PATH)
    @info "adding $tstpath to LOAD_PATH"
    push!(LOAD_PATH, tstpath)
end
=#

# utility
ls(x) = readdir(x)
ls()  = readdir()
ty(x) = typeof(x)
fn(x) = fieldnames(x)
fnty  = fn ∘ ty

iscallable(op) = !isempty(methods(op))
push(x::Tuple, val) = (x..., val)
linspace(zi::Number,ze::Number,n::Integer) = Array(range(zi,stop=ze,length=n))
