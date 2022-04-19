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
#pkgpath = dirname(dirname(@__FILE__))
#tstpath = joinpath(pkgpath, "test")
#!(tstpath in LOAD_PATH) && push!(LOAD_PATH, tstpath)

#--------------------------------------#
export linspace
linspace(zi::Number,ze::Number,n::Integer) = Array(range(zi,stop=ze,length=n))
#--------------------------------------#
export iscallable
iscallable(op) = !isempty(methods(op))
