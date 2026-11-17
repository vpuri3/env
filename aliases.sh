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

# pf [DIR] [-- PI_ARGS...]: a new pi-fleet session (pi + paired nvim window) in DIR
# (default: here). Outside tmux it opens in the tmux session "fleet" (created if
# missing) and attaches to it; PF_NO_ATTACH=1 skips the attach. Uses the tmux
# server in $PI_FLEET_TMUX_SOCKET when set (tests), else tmux's default.
_pf_tmux() {
    if [ -n "${PI_FLEET_TMUX_SOCKET:-}" ]; then
        command tmux -S "$PI_FLEET_TMUX_SOCKET" "$@"
    else
        command tmux "$@"
    fi
}
pf() {
    local dir="." pane sock
    if [ "$#" -gt 0 ] && [ "$1" != "--" ]; then
        dir="$1"
        shift
    fi
    if [ "$#" -gt 0 ]; then
        if [ "$1" != "--" ]; then
            echo "usage: pf [DIR] [-- PI_ARGS...]" >&2
            return 2
        fi
        shift
    fi
    if [ ! -d "$dir" ]; then
        echo "pf: not a directory: $dir" >&2
        return 1
    fi
    dir=$(CDPATH='' cd -- "$dir" && pwd) || return 1
    if [ -n "${TMUX:-}" ]; then
        pi-fleet open --cwd "$dir" -- "$@" >/dev/null
        return
    fi
    if ! _pf_tmux has-session -t "=fleet" 2>/dev/null; then
        _pf_tmux new-session -d -s fleet -c "$dir" || return 1
    fi
    pane=$(_pf_tmux display-message -p -t "=fleet:" '#{pane_id}') || return 1
    sock=$(_pf_tmux display-message -p -t "=fleet:" '#{socket_path}') || return 1
    PI_FLEET_TMUX_SOCKET="$sock" pi-fleet open --cwd "$dir" --target "$pane" -- "$@" >/dev/null || return 1
    if [ -n "${PF_NO_ATTACH:-}" ]; then
        return 0
    fi
    _pf_tmux attach-session -t "=fleet"
}

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
