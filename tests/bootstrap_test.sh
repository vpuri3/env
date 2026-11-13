#!/bin/bash
# Runs bootstrap.sh against throwaway home directories and checks the result.
# Uses $SHELL (bash or zsh) to choose which startup files are exercised.
#
#   SHELL=/bin/zsh tests/bootstrap_test.sh
#   SHELL=/bin/bash tests/bootstrap_test.sh

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
shell_name=$(basename "$SHELL")
os=$(uname -s)

# Test homes live under the checkout, not /tmp: bootstrap rejects PY_WD on
# temporary storage.
work=$(mktemp -d "$repo/.bootstrap-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() {
    local name="$1"
    shift
    if "$@"; then pass "$name"; else fail "$name"; fi
}

is_real_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
is_absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
no_rc_files() { is_absent "$1/.bashrc" && is_absent "$1/.zshrc" && is_absent "$1/.bash_profile"; }

base_path="/usr/bin:/bin:/usr/sbin:/sbin"

new_home() {
    local home="$work/$1"
    mkdir -p "$home/env"
    (cd "$repo" && tar --exclude='.bootstrap-test.*' -cf - .) | (cd "$home/env" && tar -xf -)
    printf '%s\n' "$home"
}

# run_in_home HOME [VAR=value ...] -- command...
run_in_home() {
    local home="$1"
    shift
    local vars=()
    while [ "$1" != "--" ]; do
        vars+=("$1")
        shift
    done
    shift
    env -i HOME="$home" PATH="$base_path" SHELL="$SHELL" USER="${USER:-runner}" TERM=dumb ENV_BOOTSTRAP_TEST=1 \
        ${vars[@]+"${vars[@]}"} "$@"
}

bootstrap() {
    local home="$1"
    shift
    run_in_home "$home" "$@" -- bash "$home/env/bootstrap.sh" --defaults --skip-installs </dev/null >/dev/null
}

rc_files() {
    if [ "$shell_name" = zsh ]; then
        printf '%s\n' .zshrc
    else
        printf '%s\n' .bashrc .bash_profile
    fi
}

snapshot() {
    local home="$1" f
    for f in $(rc_files) .gitconfig .ssh/config .config/env/local.sh; do
        printf '== %s\n' "$f"
        cat "$home/$f"
    done
}

interactive_probe() {
    local home="$1" cmd="$2"
    if [ "$shell_name" = zsh ]; then
        run_in_home "$home" -- zsh -i -c "$cmd" </dev/null 2>/dev/null
    else
        run_in_home "$home" -- bash -l -i -c "$cmd" </dev/null 2>/dev/null
    fi
}

noninteractive_probe() {
    local home="$1" cmd="$2"
    if [ "$shell_name" = zsh ]; then
        run_in_home "$home" -- zsh -c ". \"\$HOME/.zshrc\"; $cmd" </dev/null 2>&1
    else
        run_in_home "$home" -- bash -c ". \"\$HOME/.bashrc\"; $cmd" </dev/null 2>&1
    fi
}

echo "# $os + $shell_name"

###
### personal machine: PY_WD inside $HOME
###
home=$(new_home personal)
printf 'set number\n' > "$home/.vimrc"
if [ "$shell_name" = bash ]; then
    # Like Ubuntu's /etc/skel/.bashrc: returns early when not interactive.
    printf '%s\n' 'case $- in *i*) ;; *) return;; esac' "alias ll='ls -alF'" > "$home/.bashrc"
fi
if [ "$os" = Darwin ]; then
    cursor_user="$home/Library/Application Support/Cursor/User"
else
    cursor_user="$home/.config/Cursor/User"
fi
mkdir -p "$cursor_user"
printf '{}\n' > "$cursor_user/settings.json"
mkdir -p "$home/.ssh"
printf 'Host mybox\n    ForwardAgent yes\n' > "$home/.ssh/config"
printf 'Host cl1\n    HostName cl-login-01.example.org\nHost cl*\n    ForwardAgent yes\n' > "$home/.ssh/config.local"
check "bootstrap succeeds" bootstrap "$home"
first=$(snapshot "$home")
check "re-run succeeds" bootstrap "$home"
check "re-run changes nothing" [ "$first" = "$(snapshot "$home")" ]

for f in $(rc_files); do
    check "one managed block in $f" [ "$(grep -c '^# >>> env (managed' "$home/$f")" = 1 ]
done
check "existing ~/.vimrc backed up" [ -n "$(find "$home/.env-backup" -name .vimrc -type f)" ]
check "~/.vimrc linked into repo" [ "$(readlink "$home/.vimrc")" = "$home/env/vimrc" ]
check "existing Cursor settings backed up" [ -n "$(find "$home/.env-backup" -name settings.json -type f)" ]
check "Cursor settings linked into repo" [ "$(readlink "$cursor_user/settings.json")" = "$home/env/vscode_settings.json" ]
check "Cursor keybindings linked into repo" [ "$(readlink "$cursor_user/keybindings.json")" = "$home/env/vscode_keybindings.json" ]
check "pi keybindings linked into repo" [ "$(readlink "$home/.pi/agent/keybindings.json")" = "$home/env/pi/keybindings.json" ]
check "pi extensions linked into repo" [ "$(readlink "$home/.pi/agent/extensions")" = "$home/env/pi/extensions" ]
check "pi settings.json is a real file" is_real_file "$home/.pi/agent/settings.json"
check "env-deploy skill linked into repo" [ "$(readlink "$home/.agents/skills/env-deploy")" = "$home/env/skills/env-deploy" ]
check "env-add-cluster skill linked into repo" [ "$(readlink "$home/.agents/skills/env-add-cluster")" = "$home/env/skills/env-add-cluster" ]
check "no VS Code settings created when VS Code is absent" is_absent "$(dirname "$(dirname "$cursor_user")")/Code"
check "~/.gitconfig is a real file" is_real_file "$home/.gitconfig"
check "~/.ssh/config is a real file" is_real_file "$home/.ssh/config"
check "PY_WD recorded" grep -Fqx "export PY_WD='$home/python'" "$home/.config/env/local.sh"
check "no CACHE_ROOT when PY_WD is in home" bash -c "! grep -q CACHE_ROOT '$home/.config/env/local.sh'"

prompt_var=PS1
[ "$shell_name" = zsh ] && prompt_var=PROMPT
probe=$(interactive_probe "$home" "alias tmls >/dev/null && printf '%s' \"\$$prompt_var\"") || probe=""
check "interactive shell has aliases and prompt" [ -n "$probe" ]
if [ "$shell_name" = zsh ]; then
    check "zsh prompt uses zsh escapes" bash -c "case '$probe' in *%F*) exit 0;; esac; exit 1"
    keymap=$(run_in_home "$home" EDITOR=vi -- zsh -i -c 'bindkey "^R"' </dev/null 2>/dev/null) || keymap=""
    check "zsh keeps emacs keys when started with EDITOR=vi (tmux)" [ "$keymap" = '"^R" history-incremental-search-backward' ]
fi

out=$(noninteractive_probe "$home" 'printf "%s" "$PY_WD"')
check "non-interactive shell is silent and has PY_WD" [ "$out" = "$home/python" ]
out=$(noninteractive_probe "$home" 'alias tmls 2>/dev/null || printf none')
check "non-interactive shell has no aliases" [ "$out" = none ]
if [ "$shell_name" = bash ]; then
    check "one early block in .bashrc" [ "$(grep -c '^# >>> env:early' "$home/.bashrc")" = 1 ]
    out=$(interactive_probe "$home" 'alias ll')
    check "our ll wins over the distribution's" [ "${out#*=}" != "'ls -alF'" ]
fi

check "shared gitconfig included" [ -n "$(run_in_home "$home" -- git config --get alias.alog)" ]
check "git identity left unset under --defaults" bash -c "! env -i HOME='$home' PATH='$base_path' git config --get user.email"

ssh_opt() { run_in_home "$home" -- ssh -G -F "$home/.ssh/config" "$1" 2>/dev/null | awk -v k="$2" '$1 == k { print $2 }'; }
check "agent forwarded to own cluster account" [ "$(ssh_opt eagle forwardagent)" = yes ]
check "no agent forwarding to unknown hosts" [ "$(ssh_opt example.org forwardagent)" = no ]
check "machine's own host settings beat the defaults" [ "$(ssh_opt mybox forwardagent)" = yes ]
check "hosts from ~/.ssh/config.local apply" [ "$(ssh_opt cl1 hostname)" = cl-login-01.example.org ]
check "wildcards from ~/.ssh/config.local apply" [ "$(ssh_opt cl1 forwardagent)" = yes ]
first_directive=$(awk '!/^[[:space:]]*(#|$)/ { print $1; exit }' "$home/.ssh/config")
check "host includes are top-level (visible to Cursor)" [ "$first_directive" = Include ]

check "fetch over https" [ "$(cd "$home/env" && git config --get remote.origin.url)" = https://github.com/vpuri3/env.git ]
check "push over ssh" [ "$(cd "$home/env" && git config --get remote.origin.pushurl)" = git@github.com:vpuri3/env.git ]

###
### cluster: PY_WD on project space outside $HOME
###
home=$(new_home cluster-home)
project="$work/project/vpuri"
check "bootstrap with PY_WD outside home" bootstrap "$home" PY_WD="$project"
check "CACHE_ROOT follows PY_WD" grep -Fqx "CACHE_ROOT='$project/cache'" "$home/.config/env/local.sh"
mode=$(stat -c %a "$project/cache" 2>/dev/null || stat -f %Lp "$project/cache")
check "cache dir is private (700)" [ "$mode" = 700 ]
out=$(noninteractive_probe "$home" 'printf "%s|%s|%s" "$XDG_CACHE_HOME" "$TRITON_CACHE_DIR" "$HF_TOKEN_PATH"')
check "cache vars exported, HF token kept in home" [ "$out" = "$project/cache|$project/cache/triton|$home/.config/huggingface/token" ]
check "UV_LINK_MODE unset on one filesystem" bash -c "! grep -q UV_LINK_MODE '$home/.config/env/local.sh'"

if [ "$os" = Linux ] && [ -d /dev/shm ]; then
    home=$(new_home split-fs)
    check "bootstrap with cache on another filesystem" \
        bootstrap "$home" PY_WD="$work/project2" ENV_CACHE_ROOT="/dev/shm/env-test-$$"
    check "UV_LINK_MODE=copy across filesystems" grep -Fqx "export UV_LINK_MODE='copy'" "$home/.config/env/local.sh"
    rm -rf "/dev/shm/env-test-$$"
fi

###
### cluster set up by env-deploy: values passed in as ENV_*
###
home=$(new_home deployed)
storage="$work/fsw/users/vpuri"
mkdir -p "$home/.cursor-server/bin"
printf 'x\n' > "$home/.cursor-server/bin/server"
check "bootstrap with env-deploy values" bootstrap "$home" ENV_MACHINE=dfw ENV_PY_WD="$work/fsw/projects/vpuri" ENV_STORAGE_DIR="$storage"
check "MACHINE from env-deploy" grep -Fqx "MACHINE='dfw'" "$home/.config/env/local.sh"
check "PY_WD from env-deploy" grep -Fqx "export PY_WD='$work/fsw/projects/vpuri'" "$home/.config/env/local.sh"
check "STORAGE_DIR recorded" grep -Fqx "export STORAGE_DIR='$storage'" "$home/.config/env/local.sh"
check "CACHE_ROOT under STORAGE_DIR" grep -Fqx "CACHE_ROOT='$storage/cache'" "$home/.config/env/local.sh"
out=$(noninteractive_probe "$home" 'printf "%s" "$XDG_CACHE_HOME"')
check "caches exported under STORAGE_DIR" [ "$out" = "$storage/cache" ]
check "~/.cursor-server moved to STORAGE_DIR" [ "$(readlink "$home/.cursor-server")" = "$storage/.cursor-server" ]
check "~/.cursor-server contents kept" [ -f "$storage/.cursor-server/bin/server" ]
check "~/.vscode-server kept in STORAGE_DIR" [ "$(readlink "$home/.vscode-server")" = "$storage/.vscode-server" ]
mode=$(stat -c %a "$storage/.cursor-server" 2>/dev/null || stat -f %Lp "$storage/.cursor-server")
check "relocated editor servers are private (700)" [ "$mode" = 700 ]
out=$(interactive_probe "$home" 'cds >/dev/null; pwd')
check "cds goes to STORAGE_DIR" [ "$out" = "$storage" ]
if [ "$shell_name" = zsh ]; then rc=.zshrc; else rc=.bashrc; fi
out=$(run_in_home "$home" SLURM_JOB_ID=1 -- "$shell_name" -c ". \"\$HOME/$rc\"; printf '%s' \"\$MACHINE\"" </dev/null 2>/dev/null)
check "prompt names the node inside a Slurm job" [ "$out" = "dfw:$(hostname -s)" ]
check "re-run with new env-deploy PY_WD" bootstrap "$home" ENV_MACHINE=dfw ENV_PY_WD="$work/fsw/projects2/vpuri" ENV_STORAGE_DIR="$storage"
check "env-deploy PY_WD replaces the saved one" grep -Fqx "export PY_WD='$work/fsw/projects2/vpuri'" "$home/.config/env/local.sh"

machine_in() {
    run_in_home "$1" -- "$shell_name" -c ". \"\$HOME/$rc\"; printf '%s' \"\$MACHINE\"" </dev/null 2>/dev/null
}
home=$(new_home named-nodes)
check "bootstrap with node names" bootstrap "$home" ENV_MACHINE=dfw ENV_MACHINE_NAMES="other-01=dfw1 $(hostname -s)=dfw2" ENV_PY_WD="$work/fsw-named/vpuri" ENV_STORAGE_DIR="$work/fsw-named/vpuri"
check "node names recorded" grep -Fqx "MACHINE_NAMES='other-01=dfw1 $(hostname -s)=dfw2'" "$home/.config/env/local.sh"
check "listed node shows its ssh alias" [ "$(machine_in "$home")" = dfw2 ]
home=$(new_home unnamed-node)
check "bootstrap with names for other nodes" bootstrap "$home" ENV_MACHINE=dfw ENV_MACHINE_NAMES="other-01=dfw1 x$(hostname -s)=dfw9" ENV_PY_WD="$work/fsw-unnamed/vpuri" ENV_STORAGE_DIR="$work/fsw-unnamed/vpuri"
check "unlisted node shows cluster:node" [ "$(machine_in "$home")" = "dfw:$(hostname -s)" ]

###
### earlier layout: editor servers under $STORAGE_DIR/home
###
home=$(new_home old-layout)
storage="$work/fsw-old/users/vpuri"
mkdir -p "$storage/home/.cursor-server/bin" "$storage/home/.vscode-server"
printf 'x\n' > "$storage/home/.cursor-server/bin/server"
ln -s "$storage/home/.cursor-server" "$home/.cursor-server"
ln -s "$storage/home/.vscode-server" "$home/.vscode-server"
check "bootstrap migrates the old layout" bootstrap "$home" ENV_PY_WD="$storage" ENV_STORAGE_DIR="$storage"
check "editor server moved to the top of STORAGE_DIR" [ "$(readlink "$home/.cursor-server")" = "$storage/.cursor-server" ]
check "editor server contents kept" [ -f "$storage/.cursor-server/bin/server" ]
check "empty home/ removed" is_absent "$storage/home"

###
### refusals: nothing may be written
###
home=$(new_home tmp-py-wd)
check "refuses PY_WD on temp storage" bash -c "! env -i HOME='$home' PATH='$base_path' SHELL='$SHELL' PY_WD=/tmp/env-test-py bash '$home/env/bootstrap.sh' --defaults --skip-installs </dev/null >/dev/null 2>&1"
check "no local.sh after refusal" [ ! -e "$home/.config/env/local.sh" ]

home=$(new_home in-job)
check "refuses to run inside a batch job" bash -c "! env -i HOME='$home' PATH='$base_path' SHELL='$SHELL' SLURM_JOB_ID=1 bash '$home/env/bootstrap.sh' --defaults </dev/null >/dev/null 2>&1"
check "no rc files after job refusal" no_rc_files "$home"

home=$(new_home no-tty)
check "refuses without a terminal unless --defaults" bash -c "! env -i HOME='$home' PATH='$base_path' SHELL='$SHELL' bash '$home/env/bootstrap.sh' --skip-installs </dev/null >/dev/null 2>&1"

if [ "$os" = Linux ]; then
    home=$(new_home linux-zsh)
    check "refuses linux + zsh" bash -c "! env -i HOME='$home' PATH='$base_path' SHELL=/bin/zsh bash '$home/env/bootstrap.sh' --defaults </dev/null >/dev/null 2>&1"
    check "no rc files after linux + zsh refusal" no_rc_files "$home"
    if command -v zsh >/dev/null 2>&1; then
        out=$(run_in_home "$home" -- zsh -c ". \"\$HOME/env/shellrc\"; print alive" 2>/dev/null)
        check "shellrc under linux zsh warns and returns instead of exiting" [ "$out" = alive ]
    fi
fi

###
### migration from the previous bootstrap (bash only)
###
if [ "$shell_name" = bash ]; then
    home=$(new_home legacy)
    cat > "$home/.bash_profile" << EOF
# https://github.com/vpuri3/env/bootstrap.sh
[ -f \$HOME/.bashrc ] && source \$HOME/.bashrc
# Python
export PY_WD=$home/legacy-python
alias cdp='cd \$PY_WD; s'
# General environment variables
source \$HOME/env/bash_vars
source \$HOME/env/bash_alias
EOF
    ln -s "$home/env/gitconfig" "$home/.gitconfig"
    ln -s "$home/env/condarc" "$home/.condarc"
    check "bootstrap migrates legacy setup" bootstrap "$home"
    check "legacy PY_WD carried over" grep -Fqx "export PY_WD='$home/legacy-python'" "$home/.config/env/local.sh"
    check "legacy source lines removed" bash -c "! grep -q 'env/bash_vars' '$home/.bash_profile'"
    check "~/.bashrc loaded once from ~/.bash_profile" [ "$(grep -c '\.bashrc' "$home/.bash_profile")" = 1 ]
    check "legacy ~/.gitconfig link replaced by a real file" is_real_file "$home/.gitconfig"
    check "dangling legacy ~/.condarc removed" is_absent "$home/.condarc"
fi

echo
if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
