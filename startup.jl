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

