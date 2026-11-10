#!/bin/bash
# Machine bootstrap for ~/env. Supported: macOS bash, macOS zsh, Linux bash.
#
# Writes only under $HOME and the chosen PY_WD. Never uses system package
# managers or root, and leaves any existing Homebrew alone, so it is safe on
# company-managed machines and shared clusters. Safe to re-run.

if [ -z "${BASH_VERSION:-}" ]; then
    printf '%s\n' "bootstrap.sh must be run with bash." >&2
    exit 1
fi

set -eo pipefail

ENV_REPO_DIR="$HOME/env"
ENV_REPO_HTTPS="https://github.com/vpuri3/env.git"
ENV_REPO_SSH="git@github.com:vpuri3/env.git"
LOCAL_CONFIG="$HOME/.config/env/local.sh"
BLOCK_BEGIN="# >>> env (managed by ~/env/bootstrap.sh) >>>"
BLOCK_END="# <<< env <<<"
LEGACY_HEADER="# https://github.com/vpuri3/env/bootstrap.sh"

# Pinned so every machine runs the same editor; bump and re-run to upgrade.
NVIM_VERSION="v0.12.6"
NVIM_MIN_MINOR=12
TREE_SITTER_VERSION="v0.27.2"

ASSUME_DEFAULTS=0
SKIP_INSTALLS=0
BACKUP_DIR=""
LEGACY_PY_WD=""

usage() {
    cat << 'EOF'
Usage: ~/env/bootstrap.sh [--defaults] [--skip-installs]

  --defaults       Accept every default without prompting. Required when
                   stdin is not a terminal.
  --skip-installs  Configure shell startup, dotfiles, git and ssh only.
EOF
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --defaults) ASSUME_DEFAULTS=1 ;;
            --skip-installs) SKIP_INSTALLS=1 ;;
            -h|--help) usage; exit 0 ;;
            *) usage >&2; exit 2 ;;
        esac
        shift
    done
}

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

###
### prompts
###
ask_yes_no() {
    local question default hint reply
    question="$1"
    default="$2"
    if [ "$default" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi

    if [ "$ASSUME_DEFAULTS" = 1 ]; then
        info "$question $hint -> $default (default)"
        [ "$default" = y ]
        return
    fi

    read -r -p "$question $hint " reply || reply=""
    case "$reply" in
        [yY]*) return 0 ;;
        [nN]*) return 1 ;;
        *) [ "$default" = y ] ;;
    esac
}

# Sets ANSWER.
ask_value() {
    local question default reply
    question="$1"
    default="$2"

    if [ "$ASSUME_DEFAULTS" = 1 ]; then
        info "$question [$default] -> default"
        ANSWER="$default"
        return 0
    fi

    read -r -p "$question [$default] " reply || reply=""
    ANSWER="${reply:-$default}"
    case "$ANSWER" in
        "~") ANSWER="$HOME" ;;
        "~/"*) ANSWER="$HOME/${ANSWER#"~/"}" ;;
    esac
}

# Asks until the answer is non-empty. $2 is the machine's current value, if any.
ask_required() {
    local question current reply
    question="$1"
    current="$2"

    while :; do
        if [ -n "$current" ]; then
            read -r -p "$question [$current] " reply || reply=""
            ANSWER="${reply:-$current}"
        else
            read -r -p "$question " reply || die "no answer given for: $question"
            ANSWER="$reply"
        fi
        if [ -n "$ANSWER" ]; then
            return 0
        fi
    done
}

###
### path helpers
###
shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Physical absolute path, even if the tail does not exist yet.
resolve_path() {
    local path suffix
    path="$1"
    suffix=""
    while [ ! -d "$path" ]; do
        suffix="/$(basename "$path")$suffix"
        path=$(dirname "$path")
    done
    path=$(cd "$path" && pwd -P)
    if [ "$path" = / ] && [ -n "$suffix" ]; then
        path=""
    fi
    printf '%s%s\n' "$path" "$suffix"
}

path_is_under() {
    case "$1/" in
        "$2"/*) return 0 ;;
    esac
    return 1
}

# Device id of the filesystem holding $1 (or its nearest existing parent).
fs_id() {
    local path
    path="$1"
    while [ ! -e "$path" ]; do
        path=$(dirname "$path")
    done
    stat -c %d "$path" 2>/dev/null || stat -f %d "$path"
}

is_temp_path() {
    local candidate root
    candidate="$1"
    for root in /tmp /var/tmp /dev/shm /private/tmp /private/var/tmp \
        "${TMPDIR:-}" "${TMP:-}" "${SLURM_TMPDIR:-}"; do
        if [ -z "$root" ] || [ ! -d "$root" ]; then
            continue
        fi
        root=$(cd "$root" && pwd -P)
        if path_is_under "$candidate" "$root"; then
            return 0
        fi
    done
    return 1
}

###
### backups and managed blocks
###
ensure_backup_dir() {
    if [ -z "$BACKUP_DIR" ]; then
        BACKUP_DIR="$HOME/.env-backup/$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$BACKUP_DIR"
        chmod 700 "$HOME/.env-backup"
    fi
}

backup_destination() {
    local rel
    rel="${1#"$HOME"/}"
    ensure_backup_dir
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    printf '%s\n' "$BACKUP_DIR/$rel"
}

backup_copy() {
    local dest
    dest=$(backup_destination "$1")
    cp -pL "$1" "$dest"
}

backup_move() {
    local dest
    dest=$(backup_destination "$1")
    mv "$1" "$dest"
    info "moved existing $1 to $dest"
}

strip_managed_block() {
    awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
        $0 == b { skip = 1; next }
        skip && $0 == e { skip = 0; next }
        !skip
    ' "$1"
}

# Replaces (or adds) the bootstrap-managed block in $1 and leaves the rest of
# the file untouched. $2 is "top" or "bottom".
write_managed_block() {
    local file position content tmp_body tmp_new
    file="$1"
    position="$2"
    content="$3"

    mkdir -p "$(dirname "$file")"
    if [ ! -e "$file" ]; then
        : > "$file"
    fi

    tmp_body=$(mktemp)
    tmp_new=$(mktemp)
    strip_managed_block "$file" > "$tmp_body"

    if [ "$position" = top ]; then
        {
            printf '%s\n%s\n%s\n' "$BLOCK_BEGIN" "$content" "$BLOCK_END"
            if grep -q '[^[:space:]]' "$tmp_body"; then
                printf '\n'
                awk 'NF { started = 1 } started' "$tmp_body"
            fi
        } > "$tmp_new"
    else
        {
            cat "$tmp_body"
            if [ -s "$tmp_body" ] && [ -n "$(tail -n 1 "$tmp_body")" ]; then
                printf '\n'
            fi
            printf '%s\n%s\n%s\n' "$BLOCK_BEGIN" "$content" "$BLOCK_END"
        } > "$tmp_new"
    fi

    if ! cmp -s "$tmp_new" "$file"; then
        if [ -s "$file" ]; then
            backup_copy "$file"
        fi
        cat "$tmp_new" > "$file"
        info "updated $file"
    fi
    rm -f "$tmp_body" "$tmp_new"
}

file_mentions_outside_block() {
    if [ ! -f "$1" ]; then
        return 1
    fi
    strip_managed_block "$1" | grep -Fq "$2"
}

points_into_repo() {
    if [ ! -L "$1" ]; then
        return 1
    fi
    case "$(readlink "$1")" in
        "$ENV_REPO_DIR"/*) return 0 ;;
    esac
    return 1
}

link_file() {
    local source_path target_path
    source_path="$1"
    target_path="$2"

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
        return 0
    fi
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        backup_move "$target_path"
    fi
    mkdir -p "$(dirname "$target_path")"
    ln -s "$source_path" "$target_path"
    info "linked $target_path -> $source_path"
}

###
### checks
###
configure_shell_targets() {
    local os shell_name
    os=$(uname -s)
    shell_name=$(basename "${SHELL:-}")

    if [ "$os" = Linux ] && [ "$shell_name" = zsh ]; then
        die "linux + zsh is not supported. Switch your login shell to bash, then re-run bootstrap.sh."
    fi

    case "$os:$shell_name" in
        Darwin:zsh) SHELL_FAMILY=zsh ;;
        Darwin:bash|Linux:bash) SHELL_FAMILY=bash ;;
        *) die "unsupported OS/shell: $os + ${shell_name:-unset}. Supported: macOS bash, macOS zsh, Linux bash." ;;
    esac
}

check_environment() {
    if [ -n "${SLURM_JOB_ID:-}${PBS_JOBID:-}${LSB_JOBID:-}" ]; then
        die "running inside a batch job (compute node). Run bootstrap.sh from a login node."
    fi
    if [ "$ASSUME_DEFAULTS" != 1 ] && [ ! -t 0 ]; then
        die "stdin is not a terminal. Run interactively, or pass --defaults to accept every default."
    fi
}

check_prerequisites() {
    local tool
    if [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
        if ask_yes_no "Xcode command line tools (git, clang, make) are missing. Open the installer?" y; then
            xcode-select --install || true
        fi
        die "re-run bootstrap.sh once the command line tools are installed."
    fi
    for tool in git curl; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            die "$tool is required. Ask your admin, or install it, then re-run bootstrap.sh."
        fi
    done
}

###
### repo
###
repo_git() {
    (cd "$ENV_REPO_DIR" && git "$@")
}

# Fetch over HTTPS (works anywhere, no key needed); push over SSH (works once
# a key or forwarded agent is available).
ensure_repo() {
    if [ ! -d "$ENV_REPO_DIR" ]; then
        git clone "$ENV_REPO_HTTPS" "$ENV_REPO_DIR"
    fi
    if [ ! -d "$ENV_REPO_DIR/.git" ]; then
        warn "$ENV_REPO_DIR is not a git checkout; skipping remote setup"
        return 0
    fi
    if repo_git config --get remote.origin.url >/dev/null; then
        repo_git remote set-url origin "$ENV_REPO_HTTPS"
    else
        repo_git remote add origin "$ENV_REPO_HTTPS"
    fi
    repo_git remote set-url --push origin "$ENV_REPO_SSH"
}

###
### migration from the previous symlink/append-based bootstrap
###
migrate_legacy_links() {
    local link
    for link in "$HOME/.condarc" "$HOME/.codex/openrouter.env" "$HOME/.gitignore"; do
        if points_into_repo "$link"; then
            rm "$link"
            info "removed legacy link $link"
        fi
    done

    # These are written to by tools (gh, ssh-copy-id, codex), so they become
    # real local files that include the shared copy.
    for link in "$HOME/.gitconfig" "$HOME/.ssh/config"; do
        if points_into_repo "$link"; then
            rm "$link"
            info "replaced legacy link $link with a local file"
        fi
    done
    if points_into_repo "$HOME/.codex/config.toml"; then
        rm "$HOME/.codex/config.toml"
        cp "$ENV_REPO_DIR/codex/config.toml" "$HOME/.codex/config.toml"
        info "replaced legacy link ~/.codex/config.toml with a local copy"
    fi
}

migrate_legacy_bash_profile() {
    local file tmp
    file="$HOME/.bash_profile"
    if [ ! -f "$file" ] || ! grep -Fqx "$LEGACY_HEADER" "$file"; then
        return 0
    fi

    tmp=$(mktemp)
    awk -v header="$LEGACY_HEADER" '
        $0 == header { next }
        $0 == "[ -f $HOME/.bashrc ] && source $HOME/.bashrc" { next }
        $0 == "# General environment variables" { next }
        $0 == "source $HOME/env/bash_vars" { next }
        $0 == "source $HOME/env/bash_alias" { next }
        $0 == "# Python" { next }
        index($0, "export PY_WD=") == 1 { next }
        index($0, "alias cdp=") == 1 { next }
        index($0, "alias cdj=") == 1 { next }
        { print }
    ' "$file" > "$tmp"
    backup_copy "$file"
    cat "$tmp" > "$file"
    rm -f "$tmp"
    info "removed legacy env lines from $file"
}

legacy_py_wd() {
    if [ -f "$HOME/.bash_profile" ] && grep -Fqx "$LEGACY_HEADER" "$HOME/.bash_profile"; then
        sed -n 's/^export PY_WD=//p' "$HOME/.bash_profile" | tail -n 1
    fi
}

###
### machine-local config (~/.config/env/local.sh)
###
local_value() {
    if [ ! -f "$LOCAL_CONFIG" ]; then
        return 0
    fi
    (
        unset "$1"
        # shellcheck disable=SC1090
        . "$LOCAL_CONFIG" >/dev/null 2>&1
        eval "printf '%s' \"\${$1:-}\""
    )
}

configure_machine() {
    local current
    current=$(local_value MACHINE)
    ask_value "Machine name for the prompt?" "${current:-$(hostname -s)}"
    MACHINE_NAME="$ANSWER"
}

configure_python() {
    local current resolved home_resolved override uv_cache

    current=$(local_value PY_WD)
    current="${current:-${LEGACY_PY_WD:-${PY_WD:-$HOME/python}}}"

    while :; do
        ask_value "Python work directory (persistent storage, not a node-local or temp disk)?" "$current"
        case "$ANSWER" in
            /*) ;;
            *)
                if [ "$ASSUME_DEFAULTS" = 1 ]; then
                    die "PY_WD must be an absolute path: $ANSWER"
                fi
                warn "enter an absolute path"
                continue
                ;;
        esac
        resolved=$(resolve_path "$ANSWER")
        if is_temp_path "$resolved"; then
            if [ "$ASSUME_DEFAULTS" = 1 ]; then
                die "PY_WD is on temporary storage and may be wiped: $ANSWER"
            fi
            warn "$ANSWER is on temporary storage and may be wiped; choose persistent project space"
            continue
        fi
        break
    done
    PY_WD_VALUE="$ANSWER"
    mkdir -p "$PY_WD_VALUE"

    # Caches follow PY_WD off $HOME, where cluster home quotas are small.
    # ENV_CACHE_ROOT (env or local.sh) overrides, e.g. to point at scratch.
    override="${ENV_CACHE_ROOT:-$(local_value ENV_CACHE_ROOT)}"
    case "$override" in
        ""|/*) ;;
        *) die "ENV_CACHE_ROOT must be an absolute path: $override" ;;
    esac
    home_resolved=$(resolve_path "$HOME")
    CACHE_OVERRIDE_VALUE="$override"
    if [ -n "$override" ]; then
        CACHE_ROOT_VALUE="$override"
    elif [ "$resolved" = "$home_resolved" ] || path_is_under "$resolved" "$home_resolved"; then
        CACHE_ROOT_VALUE=""
    else
        CACHE_ROOT_VALUE="$PY_WD_VALUE/cache"
    fi

    if [ -n "$CACHE_ROOT_VALUE" ]; then
        mkdir -p "$CACHE_ROOT_VALUE"
        if [ -O "$CACHE_ROOT_VALUE" ]; then
            chmod 700 "$CACHE_ROOT_VALUE"
        else
            warn "$CACHE_ROOT_VALUE is not owned by you; leaving its permissions unchanged"
        fi
        info "caches: $CACHE_ROOT_VALUE"
    else
        info "caches: tool defaults under \$HOME (PY_WD is inside \$HOME)"
    fi

    # uv hardlinks from its cache into .venv only within one filesystem.
    uv_cache="${CACHE_ROOT_VALUE:-$HOME/.cache}/uv"
    if [ "$(fs_id "$PY_WD_VALUE")" != "$(fs_id "$uv_cache")" ]; then
        UV_LINK_MODE_VALUE=copy
        info "uv cache and PY_WD are on different filesystems; setting UV_LINK_MODE=copy"
    else
        UV_LINK_MODE_VALUE=""
    fi
}

configure_julia() {
    JULIA_DEPOT_VALUE=$(local_value JULIA_DEPOT_PATH)
    INSTALL_JULIA=0
    if [ "$SKIP_INSTALLS" = 1 ]; then
        return 0
    fi
    if ask_yes_no "Set up Julia (depot path, julia-vim, juliaup, Project.toml links)?" n; then
        ask_value "JULIA_DEPOT_PATH?" "${JULIA_DEPOT_VALUE:-$HOME/.julia}"
        case "$ANSWER" in
            /*) JULIA_DEPOT_VALUE="$ANSWER" ;;
            *) JULIA_DEPOT_VALUE="$HOME/.julia" ;;
        esac
        INSTALL_JULIA=1
    fi
}

write_local_config() {
    local tmp
    mkdir -p "$(dirname "$LOCAL_CONFIG")"
    tmp=$(mktemp)
    {
        printf '%s\n' "# Generated by ~/env/bootstrap.sh for this machine; re-run it to change values."
        printf 'MACHINE=%s\n' "$(shell_quote "$MACHINE_NAME")"
        printf 'export PY_WD=%s\n' "$(shell_quote "$PY_WD_VALUE")"
        if [ -n "$CACHE_OVERRIDE_VALUE" ]; then
            printf 'ENV_CACHE_ROOT=%s\n' "$(shell_quote "$CACHE_OVERRIDE_VALUE")"
        fi
        if [ -n "$CACHE_ROOT_VALUE" ]; then
            printf 'CACHE_ROOT=%s\n' "$(shell_quote "$CACHE_ROOT_VALUE")"
        fi
        if [ -n "$UV_LINK_MODE_VALUE" ]; then
            printf 'export UV_LINK_MODE=%s\n' "$(shell_quote "$UV_LINK_MODE_VALUE")"
        fi
        if [ -n "$JULIA_DEPOT_VALUE" ]; then
            printf 'export JULIA_DEPOT_PATH=%s\n' "$(shell_quote "$JULIA_DEPOT_VALUE")"
            printf 'export JULIAUP_DEPOT_PATH=%s\n' "$(shell_quote "$JULIA_DEPOT_VALUE/juliaup")"
        fi
    } > "$tmp"

    if cmp -s "$tmp" "$LOCAL_CONFIG"; then
        rm -f "$tmp"
        return 0
    fi
    if [ -f "$LOCAL_CONFIG" ]; then
        backup_copy "$LOCAL_CONFIG"
    fi
    mv "$tmp" "$LOCAL_CONFIG"
    info "wrote $LOCAL_CONFIG"
}

###
### dotfiles, git, ssh, shell startup
###
# Only files no tool writes back to are symlinked into the repo.
link_dotfiles() {
    link_file "$ENV_REPO_DIR/bin" "$HOME/bin"
    link_file "$ENV_REPO_DIR/emacs.conf" "$HOME/.emacs"
    link_file "$ENV_REPO_DIR/vimrc" "$HOME/.vimrc"
    link_file "$ENV_REPO_DIR/tmux.conf" "$HOME/.tmux.conf"
    link_file "$ENV_REPO_DIR/nvim" "$HOME/.config/nvim"
}

configure_git() {
    local file name email
    file="$HOME/.gitconfig"

    # At the top, so this machine's own settings below it take precedence.
    write_managed_block "$file" top "$(printf '[include]\n\tpath = %s' "$ENV_REPO_DIR/gitconfig")"

    name=$(git config --file "$file" --get user.name || true)
    email=$(git config --file "$file" --get user.email || true)
    if [ "$ASSUME_DEFAULTS" = 1 ]; then
        if [ -z "$name" ] || [ -z "$email" ]; then
            info "git identity not set; run: git config --file ~/.gitconfig user.name \"<name>\""
            info "                           git config --file ~/.gitconfig user.email <email>"
        fi
        return 0
    fi
    ask_required "git user.name on this machine?" "$name"
    git config --file "$file" user.name "$ANSWER"
    ask_required "git user.email on this machine (work email on company machines)?" "$email"
    git config --file "$file" user.email "$ANSWER"
}

configure_ssh() {
    local file content
    file="$HOME/.ssh/config"

    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    # ssh rejects included files that are group- or world-writable
    # (common on clusters with umask 002).
    chmod go-w "$ENV_REPO_DIR/sshconfig"

    # `Host *` resets any Host/Match block above, so the includes always apply.
    content="# Machine-specific hosts go above this block (ssh uses the first value it finds).
Host *"
    if [ -f "$HOME/.ssh/config.local" ]; then
        content="$content
    Include $HOME/.ssh/config.local"
    fi
    content="$content
    Include $ENV_REPO_DIR/sshconfig"

    write_managed_block "$file" bottom "$content"
    chmod 600 "$file"
}

configure_codex() {
    if [ -e "$HOME/.codex/config.toml" ] || [ -L "$HOME/.codex/config.toml" ]; then
        return 0
    fi
    mkdir -p "$HOME/.codex"
    cp "$ENV_REPO_DIR/codex/config.toml" "$HOME/.codex/config.toml"
    info "copied codex/config.toml to ~/.codex/config.toml"
}

configure_shell_startup() {
    local source_line rc_content profile_content bashrc_loaded

    source_line='if [ -f "$HOME/env/shellrc" ]; then . "$HOME/env/shellrc"; fi'

    if [ "$SHELL_FAMILY" = zsh ]; then
        # ~/.zshrc runs for every interactive zsh (login or not) and after
        # /etc/zshrc, so the prompt set by shellrc is not overwritten.
        write_managed_block "$HOME/.zshrc" bottom "$source_line"
        return 0
    fi

    migrate_legacy_bash_profile

    # RHEL-family clusters need /etc/bashrc for `module` in non-login shells.
    rc_content="$source_line"
    if [ -f /etc/bashrc ] && ! file_mentions_outside_block "$HOME/.bashrc" /etc/bashrc; then
        rc_content='if [ -f /etc/bashrc ]; then . /etc/bashrc; fi'"
$source_line"
    fi
    write_managed_block "$HOME/.bashrc" bottom "$rc_content"

    # Login bash reads only ~/.bash_profile. Keep ~/.profile (Ubuntu adds
    # ~/.local/bin there) and load ~/.bashrc exactly once.
    profile_content=""
    bashrc_loaded=0
    if file_mentions_outside_block "$HOME/.bash_profile" "/.bashrc"; then
        bashrc_loaded=1
    fi
    if [ -f "$HOME/.profile" ] && ! file_mentions_outside_block "$HOME/.bash_profile" "/.profile"; then
        profile_content='if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi'
        if grep -Fq "/.bashrc" "$HOME/.profile"; then
            bashrc_loaded=1
        fi
    fi
    if [ "$bashrc_loaded" = 0 ]; then
        profile_content="${profile_content:+$profile_content
}"'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi'
    fi
    write_managed_block "$HOME/.bash_profile" bottom \
        "${profile_content:-# ~/.bashrc is already loaded above.}"
}

configure_macos() {
    if [ "$(uname -s)" != Darwin ]; then
        return 0
    fi
    # `defaults` ignores $HOME, so test runs must not reach it.
    if [ "${ENV_BOOTSTRAP_TEST:-0}" = 1 ]; then
        return 0
    fi
    # Key repeat instead of the accent popup (user-level preference).
    defaults write -g ApplePressAndHoldEnabled -bool false
}

###
### optional user-local installs (all under ~/.local)
###
download_to() {
    curl -fsSL --retry 2 "$1" -o "$2"
}

# Prints the version of an nvim binary (e.g. 0.12.6), or nothing if it does not run.
nvim_version_of() {
    [ -n "$1" ] || return 0
    "$1" --version 2>/dev/null | sed -n '1s/^NVIM v\([0-9][0-9.]*\).*/\1/p' || true
}

# True if version $1 is at least 0.$NVIM_MIN_MINOR.
nvim_is_supported() {
    local major minor
    [ -n "$1" ] || return 1
    major=${1%%.*}
    minor=${1#*.}
    minor=${minor%%.*}
    [ "$major" -gt 0 ] || [ "$minor" -ge "$NVIM_MIN_MINOR" ]
}

install_neovim() {
    local archive_name install_root tmp_dir extracted_dir

    install_root="$HOME/.local/neovim"
    case "$(uname -s):$(uname -m)" in
        Darwin:arm64) archive_name="nvim-macos-arm64.tar.gz" ;;
        Darwin:x86_64) archive_name="nvim-macos-x86_64.tar.gz" ;;
        Linux:x86_64) archive_name="nvim-linux-x86_64.tar.gz" ;;
        Linux:aarch64|Linux:arm64) archive_name="nvim-linux-arm64.tar.gz" ;;
        *) warn "no Neovim build for $(uname -s) $(uname -m)"; return 1 ;;
    esac

    mkdir -p "$HOME/.local/bin"
    tmp_dir=$(mktemp -d "$HOME/.local/.nvim-install.XXXXXX")
    if ! download_to "https://github.com/neovim/neovim/releases/download/$NVIM_VERSION/$archive_name" "$tmp_dir/$archive_name" \
        || ! tar -C "$tmp_dir" -xzf "$tmp_dir/$archive_name"; then
        warn "Neovim download failed; keeping the current install"
        rm -rf "$tmp_dir"
        return 1
    fi

    extracted_dir=$(find "$tmp_dir" -maxdepth 1 -mindepth 1 -type d -name 'nvim-*' | head -n 1)
    if [ -z "$(nvim_version_of "${extracted_dir:-/nonexistent}/bin/nvim")" ]; then
        warn "downloaded Neovim does not run on this machine (often an old glibc); keeping the current install"
        rm -rf "$tmp_dir"
        return 1
    fi

    if [ -e "$install_root" ]; then
        mv "$install_root" "$tmp_dir/previous"
    fi
    mv "$extracted_dir" "$install_root"
    ln -sfn "$install_root/bin/nvim" "$HOME/.local/bin/nvim"
    rm -rf "$tmp_dir"
    hash -r
    info "installed Neovim $NVIM_VERSION in $install_root"
}

# Prints the version of the tree-sitter CLI on PATH (e.g. 0.27.2), or nothing.
tree_sitter_version() {
    tree-sitter --version 2>/dev/null | sed -n '1s/^tree-sitter \([0-9][0-9.]*\).*/\1/p' || true
}

# nvim-treesitter (main branch) builds parsers with tree-sitter CLI 0.26.1+.
tree_sitter_is_supported() {
    local version minor patch
    version=$(tree_sitter_version)
    [ -n "$version" ] || return 1
    minor=${version#*.}
    patch=${minor#*.}
    minor=${minor%%.*}
    [ "${version%%.*}" -gt 0 ] || [ "$minor" -gt 26 ] || { [ "$minor" -eq 26 ] && [ "${patch%%.*}" -ge 1 ]; }
}

install_tree_sitter() {
    local asset tmp_dir

    case "$(uname -s):$(uname -m)" in
        Darwin:arm64) asset="tree-sitter-macos-arm64.gz" ;;
        Darwin:x86_64) asset="tree-sitter-macos-x64.gz" ;;
        Linux:x86_64) asset="tree-sitter-linux-x64.gz" ;;
        Linux:aarch64|Linux:arm64) asset="tree-sitter-linux-arm64.gz" ;;
        *) warn "no tree-sitter build for $(uname -s) $(uname -m)"; return 1 ;;
    esac

    mkdir -p "$HOME/.local/bin"
    tmp_dir=$(mktemp -d "$HOME/.local/.tree-sitter-install.XXXXXX")
    if ! download_to "https://github.com/tree-sitter/tree-sitter/releases/download/$TREE_SITTER_VERSION/$asset" "$tmp_dir/tree-sitter.gz" \
        || ! gunzip "$tmp_dir/tree-sitter.gz"; then
        warn "tree-sitter download failed"
        rm -rf "$tmp_dir"
        return 1
    fi
    chmod +x "$tmp_dir/tree-sitter"
    if ! "$tmp_dir/tree-sitter" --version >/dev/null 2>&1; then
        warn "downloaded tree-sitter does not run on this machine (often an old glibc)"
        rm -rf "$tmp_dir"
        return 1
    fi
    mv "$tmp_dir/tree-sitter" "$HOME/.local/bin/tree-sitter"
    rm -rf "$tmp_dir"
    hash -r
    info "installed tree-sitter $TREE_SITTER_VERSION in ~/.local/bin"
}

# Installs plugins (packer, configured in nvim/lua/nvconf/packer.lua) and
# treesitter parsers headless, so the first interactive launch is clean.
# Never updates plugins that are already installed; run :PackerSync for that.
setup_neovim_plugins() {
    local nvim_bin data_dir packer_dir log parser_count

    nvim_bin=$1
    data_dir=$("$nvim_bin" --headless --clean -c 'lua io.stdout:write(vim.fn.stdpath("data"))' -c 'qa!' 2>/dev/null)
    if [ -z "$data_dir" ]; then
        warn "could not locate the Neovim data directory; skipping plugin setup"
        return 0
    fi
    log="$data_dir/env-bootstrap.log"
    mkdir -p "$data_dir"
    : > "$log"

    # Cloning packer up front stops packer.lua from starting its own async
    # sync, which a headless run would cut short.
    packer_dir="$data_dir/site/pack/packer/start/packer.nvim"
    if [ ! -d "$packer_dir" ] \
        && ! git clone --quiet --depth 1 https://github.com/wbthomason/packer.nvim "$packer_dir" >>"$log" 2>&1; then
        warn "could not download packer.nvim; see $log"
        return 0
    fi

    info "installing Neovim plugins..."
    if ! "$nvim_bin" --headless -c 'autocmd User PackerComplete quitall' -c 'PackerInstall' >>"$log" 2>&1; then
        warn "Neovim plugin install reported errors; see $log"
    fi

    if ! tree_sitter_is_supported && ! install_tree_sitter; then
        warn "skipping treesitter parsers (needs tree-sitter CLI 0.26.1+)"
        return 0
    fi
    if ! command -v cc >/dev/null 2>&1; then
        warn "no C compiler (cc) found; skipping treesitter parsers"
        return 0
    fi

    info "building treesitter parsers..."
    "$nvim_bin" --headless \
        -c 'lua local p = vim.g.env_treesitter_parsers; if p then require("nvim-treesitter").install(p):wait(900000) end' \
        -c 'qa!' >>"$log" 2>&1 || true
    parser_count=$(find "$data_dir/site/parser" -name '*.so' 2>/dev/null | wc -l | tr -d ' ')
    info "treesitter parsers installed: $parser_count (log: $log)"
}

maybe_install_neovim() {
    local local_nvim current nvim_bin

    local_nvim="$HOME/.local/neovim/bin/nvim"
    current=$(nvim_version_of "$local_nvim")
    if [ -n "$current" ]; then
        if [ "v$current" = "$NVIM_VERSION" ]; then
            info "Neovim $NVIM_VERSION already installed in ~/.local/neovim"
        elif ask_yes_no "Switch user-local Neovim from v$current to $NVIM_VERSION?" y; then
            install_neovim || true
        fi
    elif command -v nvim >/dev/null 2>&1; then
        current=$(nvim_version_of "$(command -v nvim)")
        if nvim_is_supported "$current"; then
            if ask_yes_no "Neovim v$current found at $(command -v nvim). Also install $NVIM_VERSION in ~/.local/neovim?" n; then
                install_neovim || true
            fi
        elif ask_yes_no "Neovim at $(command -v nvim) is ${current:+v}${current:-not runnable}; the config needs 0.$NVIM_MIN_MINOR+. Install $NVIM_VERSION in ~/.local/neovim?" y; then
            install_neovim || true
        fi
    elif ask_yes_no "Install Neovim $NVIM_VERSION in ~/.local/neovim?" y; then
        install_neovim || true
    fi

    nvim_bin=$(command -v nvim || true)
    current=$(nvim_version_of "$nvim_bin")
    if ! nvim_is_supported "$current"; then
        info "no Neovim 0.$NVIM_MIN_MINOR+ on PATH; skipping plugin setup"
        return 0
    fi
    if ask_yes_no "Install Neovim plugins and treesitter parsers?" y; then
        setup_neovim_plugins "$nvim_bin"
    fi
}

maybe_install_uv() {
    if command -v uv >/dev/null 2>&1; then
        info "uv found at $(command -v uv); skipping"
        return 0
    fi
    if ask_yes_no "Install uv in ~/.local/bin?" y; then
        if ! curl -LsSf https://astral.sh/uv/install.sh \
            | env UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh; then
            warn "uv install failed"
        fi
    fi
}

install_nodejs_user_local() {
    local os arch node_arch version archive_name install_root bin_dir tmp_dir extracted_dir

    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)
    install_root="$HOME/.local/node"
    bin_dir="$HOME/.local/bin"

    case "$arch" in
        x86_64) node_arch="x64" ;;
        aarch64|arm64) node_arch="arm64" ;;
        *) warn "no Node.js build for $arch"; return 1 ;;
    esac

    # LTS releases carry a codename string; non-LTS entries have "lts":false.
    version=$(curl -fsSL https://nodejs.org/dist/index.json \
        | tr '{' '\n' | grep -m1 '"lts":"' | sed -E 's/.*"version":"([^"]+)".*/\1/')
    if [ -z "$version" ]; then
        warn "could not determine the latest Node.js LTS version"
        return 1
    fi

    archive_name="node-$version-$os-$node_arch.tar.xz"
    mkdir -p "$bin_dir"
    tmp_dir=$(mktemp -d "$HOME/.local/.node-install.XXXXXX")
    if ! download_to "https://nodejs.org/dist/$version/$archive_name" "$tmp_dir/$archive_name" \
        || ! tar -C "$tmp_dir" -xf "$tmp_dir/$archive_name"; then
        rm -rf "$tmp_dir"
        warn "Node.js download failed"
        return 1
    fi

    extracted_dir="$tmp_dir/node-$version-$os-$node_arch"
    if ! "$extracted_dir/bin/node" --version >/dev/null 2>&1; then
        rm -rf "$tmp_dir"
        warn "downloaded Node.js does not run on this machine (often an old glibc)"
        return 1
    fi

    if [ -e "$install_root" ]; then
        mv "$install_root" "$tmp_dir/previous"
    fi
    mv "$extracted_dir" "$install_root"
    ln -sfn "$install_root/bin/node" "$bin_dir/node"
    ln -sfn "$install_root/bin/npm" "$bin_dir/npm"
    ln -sfn "$install_root/bin/npx" "$bin_dir/npx"
    rm -rf "$tmp_dir"
}

maybe_install_codex() {
    if command -v codex >/dev/null 2>&1; then
        info "codex found at $(command -v codex); skipping"
        return 0
    fi
    if ! ask_yes_no "Install OpenAI Codex CLI in ~/.local?" n; then
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        if ! ask_yes_no "npm is missing. Install Node.js LTS in ~/.local/node?" y; then
            return 0
        fi
        if ! install_nodejs_user_local; then
            warn "skipping Codex CLI"
            return 0
        fi
    fi
    # --prefix keeps the install out of whatever prefix owns node (Homebrew, IT).
    if ! npm install -g --prefix "$HOME/.local" @openai/codex; then
        warn "Codex CLI install failed"
    fi
}

maybe_install_claude() {
    if command -v claude >/dev/null 2>&1; then
        info "claude found at $(command -v claude); skipping"
        return 0
    fi
    if ask_yes_no "Install Claude Code in ~/.local?" n; then
        if ! curl -fsSL https://claude.ai/install.sh | bash; then
            warn "Claude Code install failed"
        fi
    fi
}

install_julia() {
    local version
    mkdir -p "$HOME/.vim/pack/plugins/start"
    if [ ! -d "$HOME/.vim/pack/plugins/start/julia-vim" ]; then
        git clone https://github.com/JuliaEditorSupport/julia-vim.git "$HOME/.vim/pack/plugins/start/julia-vim"
    fi

    if ! command -v juliaup >/dev/null 2>&1; then
        if ! curl -fsSL https://install.julialang.org \
            | env JULIA_DEPOT_PATH="$JULIA_DEPOT_VALUE" JULIAUP_DEPOT_PATH="$JULIA_DEPOT_VALUE/juliaup" sh; then
            warn "juliaup install failed"
        fi
    fi

    mkdir -p "$JULIA_DEPOT_VALUE/config"
    ln -sfn "$ENV_REPO_DIR/startup.jl" "$JULIA_DEPOT_VALUE/config/startup.jl"
    for version in v1.9 v1.10 v1.11 v1.12 v1.13; do
        mkdir -p "$JULIA_DEPOT_VALUE/environments/$version"
        ln -sfn "$ENV_REPO_DIR/JL_Project.toml" "$JULIA_DEPOT_VALUE/environments/$version/Project.toml"
    done
}

install_tools() {
    maybe_install_neovim
    maybe_install_uv
    maybe_install_codex
    maybe_install_claude
    if [ "$INSTALL_JULIA" = 1 ]; then
        install_julia
    fi
}

main() {
    parse_args "$@"
    configure_shell_targets
    check_environment
    check_prerequisites
    PATH="$HOME/.local/bin:$PATH"

    ensure_repo
    LEGACY_PY_WD=$(legacy_py_wd)
    migrate_legacy_links

    configure_machine
    configure_python
    configure_julia
    write_local_config

    link_dotfiles
    configure_git
    configure_ssh
    configure_codex
    configure_shell_startup
    configure_macos

    if [ "$SKIP_INSTALLS" != 1 ]; then
        install_tools
    fi

    info ""
    if [ -n "$BACKUP_DIR" ]; then
        info "Replaced files were saved in $BACKUP_DIR"
    fi
    info "Done. Open a new shell to load the environment."
}

main "$@"
