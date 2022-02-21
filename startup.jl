#
"""
 to run file `script.jl`, do
 ```julia
 @run script
 ```

 TODO:
 -add completion support
"""
macro run(file)
    fs = String(file)
    fn = fs * ".jl"
    return :(include($fn))
end

#--------------------------------------#
export linspace
linspace(zi::Number,ze::Number,n::Integer) = Array(range(zi,stop=ze,length=n))
#--------------------------------------#
export iscallable
iscallable(op) = !isempty(methods(op))
