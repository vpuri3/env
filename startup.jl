#
@static if Sys.isapple() && Sys.ARCH == :aarch64
    using AppleAccelerate
    @info "Loaded AppleAccelerate"
elseif Sys.ARCH == :x86_64
    using MKL
    @info "Loaded MKL"
end

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

# utils
ls(x) = readdir(x)
ls()  = readdir()
ty(x) = typeof(x)
fn(x) = fieldnames(x)
fnty  = fn ∘ ty

"""
    _num_threads() -> Sys.CPU_THREADS

Get the number of CPU threads on the machine.
"""
_num_threads() = Sys.CPU_THREADS

"""
    _num_cores()

Get the number of CPU cores on the machine.
On M-series Macs, `Sys.cpu_info()` returns all cores (even, e-cores).
We take minimum here as we are only interested in the # of p-cores.
"""
_num_cores() = min(_num_threads(), length(Sys.cpu_info()))

push(x::Tuple, val) = (x..., val)

# TODO make macro @capture_out include("script.jl")
function capture_out(script::AbstractString)
    open(script * ".stdout", "w") do io
        redirect_stdout(io) do
            include(script * ".jl")
        end
    end
end

