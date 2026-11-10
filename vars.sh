#!/bin/bash
# Environment shared by bash and zsh. Sourced by ~/env/shellrc after
# ~/.config/env/local.sh. Only sets variables: no directory creation or
# filesystem probes, so a slow network filesystem cannot hang a login.

# Moves $1 to the front of PATH even if it is already present, so user dirs
# win after macOS path_helper reorders PATH in login shells (e.g. tmux).
path_prepend() {
    PATH=":$PATH:"
    PATH="${PATH//:"$1":/:}"
    PATH="${PATH#:}"
    PATH="${PATH%:}"
    PATH="$1${PATH:+:$PATH}"
}

# Uses whatever Homebrew is already on the machine (personal or IT-managed).
# brew shellenv emits bash or zsh syntax based on the calling shell.
load_homebrew() {
    local brew_bin brew_env
    if [ -z "${HOMEBREW_PREFIX:-}" ]; then
        if [ -x /opt/homebrew/bin/brew ]; then
            brew_bin=/opt/homebrew/bin/brew
        elif [ -x /usr/local/bin/brew ]; then
            brew_bin=/usr/local/bin/brew
        else
            return 0
        fi
        brew_env="$("$brew_bin" shellenv)"
        eval "$brew_env"
    fi
    path_prepend "$HOMEBREW_PREFIX/sbin"
    path_prepend "$HOMEBREW_PREFIX/bin"
}

ME=$(whoami)
MACHINE="${MACHINE:-$(hostname -s)}"
# MACHINE names the whole cluster (all nodes share one home); inside a Slurm
# job, also show which compute node this shell is on.
if [ -n "${SLURM_JOB_ID:-}" ]; then
    MACHINE="$MACHINE:$(hostname -s)"
fi

###
### misc vars
###
export EDITOR="vi"

# tmux uses TMUX_TMPDIR (not TMPDIR) for its socket directory.
if [ -n "${TMPDIR:-}" ]; then
    export TMUX_TMPDIR="$TMPDIR"
elif [ -n "${TMP:-}" ]; then
    export TMUX_TMPDIR="$TMP"
fi

# Disable XON/XOFF flow control so Ctrl-S remains usable for tmux over SSH.
if [ -t 0 ]; then
    stty -ixon
fi

case "$(uname)" in
Darwin)
    path_prepend "/usr/local/sbin"
    path_prepend "/usr/local/bin"
    load_homebrew
    ;;
esac

###
### user scripts and user-local installs (nvim, uv, node) take precedence
###
path_prepend "$HOME/bin"
path_prepend "$HOME/.local/bin"
export PATH

###
### Prompt
###
# bash prompt escapes (\[ \e \W) are literal in zsh. Set one or the other.
if [ -n "${ZSH_VERSION:-}" ]; then
    # zsh displays $PROMPT itself; this file never expands it.
    # shellcheck disable=SC2034
    PROMPT="[%F{green}${ME}%f%B%F{cyan}@${MACHINE}%b%f %1~]:"
else
    export PS1="[\[\e[0;32m\]$ME\[\e[1;36m\]@$MACHINE\[\e[0m\] \W]:"
fi

###
### Python work directory and caches
###
# PY_WD holds code and must be on persistent storage.
# CACHE_ROOT is set by bootstrap.sh (in local.sh) only when PY_WD is outside
# $HOME, i.e. on clusters where home quotas are small. When unset, every tool
# keeps its default cache location.
export PY_WD="${PY_WD:-$HOME/python}"

if [ -n "${CACHE_ROOT:-}" ]; then
    export CACHE_ROOT
    # uv, Hugging Face, torch, pip (Linux), vLLM all follow XDG_CACHE_HOME.
    export XDG_CACHE_HOME="$CACHE_ROOT"
    # These ignore XDG_CACHE_HOME or default to other dirs under $HOME.
    export TRITON_CACHE_DIR="$CACHE_ROOT/triton"
    export WANDB_CACHE_DIR="$CACHE_ROOT/wandb"
    export WANDB_DATA_DIR="$CACHE_ROOT/wandb-data"
    export CUDA_CACHE_PATH="$CACHE_ROOT/nv"
    export UV_PYTHON_INSTALL_DIR="$CACHE_ROOT/uv-python"
    # HF_HOME moves with XDG_CACHE_HOME; keep the login token in home, since
    # project dirs are often group-readable.
    export HF_TOKEN_PATH="$HOME/.config/huggingface/token"
fi
