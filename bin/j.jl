#!/bin/bash
#=
exec julia --color=yes "${BASH_SOURCE[0]}" "$@"
=#

@show ARGS  # put any Julia code here
