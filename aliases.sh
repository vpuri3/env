#!/bin/bash
# Interactive aliases shared by bash and zsh. Sourced by ~/env/shellrc.

# navigation
alias ..='cd ..'
alias dc='cd -'
alias cdp='cd $PY_WD; ll'
alias cds='cd "${STORAGE_DIR:-$HOME}"; ll'

# file operations
alias scp='scp -r'
alias tc='tar -cvf'
alias tx='tar -xvf'

# process control
alias kk='kill'
alias ka='killall'
alias ka9='killall -9'
alias k9='kill -9'

# shell and editor
alias nv='nvim'
alias em='emacs -nw'
alias tmls='tmux ls'
alias cl='claude --dangerously-skip-permissions'
alias cx='codex -s danger-full-access'
alias vact='. "$HOME/env/shellrc" && . "${PWD}/.venv/bin/activate"'

# viewers
alias hn='head -n'
alias hn1='head -n 1'
alias tf='tail -f'
alias le='less'
alias whereami='hostname'
alias sx='sxiv -b'

# schedulers
alias qs='qstat -u $(whoami)'
alias sq='squeue -u $(whoami)'
alias sqw='watch squeue -u $(whoami)'

# git
alias ga='git add'
alias gau='git add -u'
alias gb='git branch'
alias gc='git commit'
alias gcm='git commit -m'
alias gco='git checkout'
alias gd='git diff'
alias gdf='git difftool'
alias gs='git status'
alias gpull='git pull'
alias gpush='git push'
alias gpushu='git push -u origin HEAD'

# toolchains
alias uvr='uv run'

# julia
alias cdj='cd "${JULIA_DEPOT_PATH:-$HOME/.julia}/dev"; ll'
alias jl='julia --proj'
alias jj='julia +beta --proj'
alias jlts='julia +lts --proj'
alias jup='juliaup'

case "$(uname)" in
Darwin)
    # macOS utilities
    alias ll='ls -lh -G'
    alias la='ls -lA -G'
    alias lt='ls -ltr -G'
    alias cdv='cd $HOME/vedant; ll'
    alias cdg='cd $HOME/Google\ Drive; ll'
    alias cdc='cd $HOME/cmu; ll'
    alias cdd='cd $HOME/Downloads; ll'
    alias cdr='cd $HOME/read; ll'
    alias disp='open /System/Library/PreferencePanes/Displays.prefPane'
    alias opcr='open -a /Applications/Google\ Chrome.app/'
    alias bdep='brew deps --tree'
    ;;
Linux)
    # Linux utilities
    alias ll='ls -lh --color=tty'
    alias la='ls -lA --color=tty'
    alias lt='ls -ltr --color=tty'
    # $3/$4 are awk fields, not alias arguments.
    # shellcheck disable=SC2142
    alias fgpu='sinfo -N -O "partition:15,nodelist:25,gres:15,gresused:15,statecompact:10" | awk '\''NR==1 || ($4!="gpu:8" && $3~/gpu/)'\'' | column -t'
    ;;
esac
