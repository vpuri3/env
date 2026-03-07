#!/bin/bash

set -e

ENV_REPO_DIR="$HOME/env"
ENV_REPO_HTTPS="https://github.com/vpuri3/env.git"
ENV_REPO_SSH="git@github.com:vpuri3/env.git"
PROFILE_FILE="$HOME/.bash_profile"
BASHRC_FILE="$HOME/.bashrc"

append_line_if_missing() {
    local file line
    file="$1"
    line="$2"

    touch "$file"
    grep -Fqx "$line" "$file" || printf '%s\n' "$line" >> "$file"
}

upsert_prefix_line() {
    local file prefix line tmp_file
    file="$1"
    prefix="$2"
    line="$3"
    tmp_file=$(mktemp)

    touch "$file"
    awk -v prefix="$prefix" 'index($0, prefix) != 1' "$file" > "$tmp_file"
    printf '%s\n' "$line" >> "$tmp_file"
    mv "$tmp_file" "$file"
}

prompt_yes_no() {
    local prompt reply
    prompt="$1"

    read -r -p "$prompt [Y/n] " reply
    case "$reply" in
        [nN]*) return 1 ;;
        *) return 0 ;;
    esac
}

ensure_profile_bootstrap() {
    touch "$PROFILE_FILE" "$BASHRC_FILE"
    append_line_if_missing "$PROFILE_FILE" "# https://github.com/vpuri3/env/bootstrap.sh"
    append_line_if_missing "$PROFILE_FILE" "[ -f \$HOME/.bashrc ] && source \$HOME/.bashrc"
}

clone_env_repo() {
    cd "$HOME"

    if [ ! -d "$ENV_REPO_DIR" ]; then
        git clone "$ENV_REPO_HTTPS" "$ENV_REPO_DIR"
    fi

    cd "$ENV_REPO_DIR"
    if git remote get-url origin >/dev/null 2>&1; then
        git remote set-url origin "$ENV_REPO_SSH"
    else
        git remote add origin "$ENV_REPO_SSH"
    fi
}

link_file() {
    local source_path target_path
    source_path="$1"
    target_path="$2"

    mkdir -p "$(dirname "$target_path")"
    ln -sfn "$source_path" "$target_path"
}

ensure_ssh_local_config() {
    local target_path
    target_path="$HOME/.ssh/config.local"

    mkdir -p "$HOME/.ssh"
    if [ ! -f "$target_path" ]; then
        cp "$ENV_REPO_DIR/sshconfig.local.example" "$target_path"
    fi
}

symlink_dotfiles() {
    chmod +x "$ENV_REPO_DIR"/bin/*

    link_file "$ENV_REPO_DIR/bin" "$HOME/bin"
    link_file "$ENV_REPO_DIR/emacs.conf" "$HOME/.emacs"
    link_file "$ENV_REPO_DIR/vimrc" "$HOME/.vimrc"
    link_file "$ENV_REPO_DIR/gitconfig" "$HOME/.gitconfig"
    link_file "$ENV_REPO_DIR/gitignore" "$HOME/.gitignore"
    link_file "$ENV_REPO_DIR/tmux.conf" "$HOME/.tmux.conf"
    link_file "$ENV_REPO_DIR/condarc" "$HOME/.condarc"
    link_file "$ENV_REPO_DIR/sshconfig" "$HOME/.ssh/config"
    ensure_ssh_local_config
    link_file "$ENV_REPO_DIR/nvim" "$HOME/.config/nvim"
}

install_neovim() {
    local os arch archive_url archive_name install_root bin_dir tmp_dir extracted_dir

    os=$(uname -s)
    arch=$(uname -m)
    install_root="$HOME/.local/neovim"
    bin_dir="$HOME/.local/bin"
    tmp_dir=$(mktemp -d)

    case "$os" in
        Darwin)
            case "$arch" in
                arm64) archive_name="nvim-macos-arm64.tar.gz" ;;
                x86_64) archive_name="nvim-macos-x86_64.tar.gz" ;;
                *)
                    echo "Unsupported macOS architecture for Neovim: $arch"
                    rm -rf "$tmp_dir"
                    return 1
                    ;;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64) archive_name="nvim-linux-x86_64.tar.gz" ;;
                aarch64|arm64) archive_name="nvim-linux-arm64.tar.gz" ;;
                *)
                    echo "Unsupported Linux architecture for Neovim: $arch"
                    rm -rf "$tmp_dir"
                    return 1
                    ;;
            esac
            ;;
        *)
            echo "Unsupported OS for Neovim install: $os"
            rm -rf "$tmp_dir"
            return 1
            ;;
    esac

    archive_url="https://github.com/neovim/neovim/releases/download/stable/$archive_name"

    mkdir -p "$bin_dir"
    curl -fL "$archive_url" -o "$tmp_dir/$archive_name" || {
        rm -rf "$tmp_dir"
        return 1
    }

    tar -C "$tmp_dir" -xzf "$tmp_dir/$archive_name" || {
        rm -rf "$tmp_dir"
        return 1
    }

    extracted_dir=$(find "$tmp_dir" -maxdepth 1 -mindepth 1 -type d -name 'nvim-*' | head -n 1)
    if [ -z "$extracted_dir" ]; then
        echo "Failed to locate extracted Neovim directory"
        rm -rf "$tmp_dir"
        return 1
    fi

    rm -rf "$install_root"
    mv "$extracted_dir" "$install_root"
    ln -sfn "$install_root/bin/nvim" "$bin_dir/nvim"
    ln -sfn "$install_root/bin/nvim" "$bin_dir/nv"
    rm -rf "$tmp_dir"
}

install_macos_packages() {
    if prompt_yes_no "Install xcode command line tools?"; then
        xcode-select -p >/dev/null 2>&1 || xcode-select --install
    fi

    if prompt_yes_no "Install Homebrew?"; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        append_line_if_missing "$BASHRC_FILE" "# Homebrew"
        append_line_if_missing "$BASHRC_FILE" 'eval "$(/opt/homebrew/bin/brew shellenv)"'
    fi

    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        brew install wget vim
    fi

    defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false
}

install_linux_packages() {
    if [ -f /etc/lsb-release ] && grep -q "Ubuntu" /etc/lsb-release; then
        if command -v apt >/dev/null 2>&1; then
            if prompt_yes_no "Update and install packages on Ubuntu with apt?"; then
                sudo apt update
                sudo apt list --upgradable
                sudo apt upgrade -y
                sudo apt install -y wget vim python3-pip
            fi
        elif command -v snap >/dev/null 2>&1; then
            if prompt_yes_no "apt not available. Install packages on Ubuntu with snap?"; then
                sudo snap refresh
                sudo snap install wget vim
                echo "Note: You may need to install python3-pip separately using your system's package manager"
            fi
        else
            echo "Neither apt nor snap available on this Ubuntu system"
        fi
    fi
}

install_platform_packages() {
    case "$(uname -s)" in
        Darwin) install_macos_packages ;;
        Linux) install_linux_packages ;;
    esac
}

install_julia_vim() {
    if ! prompt_yes_no "Install Julia-vim plugin?"; then
        return 0
    fi

    mkdir -p "$HOME/.vim/pack/plugins/start"
    if [ ! -d "$HOME/.vim/pack/plugins/start/julia-vim" ]; then
        git clone https://github.com/JuliaEditorSupport/julia-vim.git "$HOME/.vim/pack/plugins/start/julia-vim"
    fi
}

configure_julia_paths() {
    local dir depot_path

    read -r -p "Set JULIA_DEPOT_PATH? Enter full path. [$HOME/.julia] " dir
    if [[ "$dir" = /* ]]; then
        depot_path="$dir"
    else
        depot_path="$HOME/.julia"
    fi

    export JULIA_DEPOT_PATH="$depot_path"
    export JULIAUP_DEPOT_PATH="$depot_path/juliaup"

    append_line_if_missing "$PROFILE_FILE" "# Julia"
    upsert_prefix_line "$PROFILE_FILE" "export JULIA_DEPOT_PATH=" "export JULIA_DEPOT_PATH=$JULIA_DEPOT_PATH"
    upsert_prefix_line "$PROFILE_FILE" "export JULIAUP_DEPOT_PATH=" "export JULIAUP_DEPOT_PATH=$JULIAUP_DEPOT_PATH"
    upsert_prefix_line "$PROFILE_FILE" "alias cdj=" "alias cdj='cd \$JULIA_DEPOT_PATH/dev; s'"
}

install_juliaup() {
    if ! prompt_yes_no "Install Julia via juliaup?"; then
        return 0
    fi

    curl -fsSL https://install.julialang.org | sh
    mkdir -p "$HOME/.julia/config"
    ln -sfn "$ENV_REPO_DIR/startup.jl" "$HOME/.julia/config/startup.jl"
}

link_julia_projects() {
    local version

    : "${JULIA_DEPOT_PATH:=$HOME/.julia}"

    for version in v1.9 v1.10 v1.11 v1.12 v1.13; do
        mkdir -p "$JULIA_DEPOT_PATH/environments/$version"
        ln -sfn "$ENV_REPO_DIR/JL_Project.toml" "$JULIA_DEPOT_PATH/environments/$version/Project.toml"
    done
}

install_spack() {
    if ! prompt_yes_no "Install Spack?"; then
        return 0
    fi

    if [ ! -d "$HOME/spack" ]; then
        git clone https://github.com/spack/spack.git "$HOME/spack"
    fi

    append_line_if_missing "$PROFILE_FILE" "# spack"
    append_line_if_missing "$PROFILE_FILE" "source \$HOME/spack/share/spack/setup-env.sh"
}

configure_python_workdir() {
    local dir py_wd

    read -r -p "Set Python work directory? Enter full path. [$HOME/python] " dir
    if [[ "$dir" = /* ]]; then
        py_wd="$dir"
    else
        py_wd="$HOME/python"
    fi

    export PY_WD="$py_wd"

    append_line_if_missing "$PROFILE_FILE" "# Python"
    upsert_prefix_line "$PROFILE_FILE" "export PY_WD=" "export PY_WD=$PY_WD"
    upsert_prefix_line "$PROFILE_FILE" "alias cdp=" "alias cdp='cd \$PY_WD; s'"
}

install_uv() {
    if command -v uv >/dev/null 2>&1; then
        echo "uv is already installed, skipping installation"
        return 0
    fi

    if prompt_yes_no "Install uv?"; then
        echo "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        uv self update
    fi
}

can_use_sudo() {
    command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1
}

install_nodejs_user_local() {
    local os arch node_arch version json_url archive_name archive_url install_root bin_dir tmp_dir extracted_dir

    os=$(uname -s)
    arch=$(uname -m)
    install_root="$HOME/.local/node"
    bin_dir="$HOME/.local/bin"
    tmp_dir=$(mktemp -d)
    json_url="https://nodejs.org/dist/index.json"

    case "$os" in
        Darwin) ;;
        Linux) ;;
        *)
            echo "Unsupported OS for user-local Node.js install: $os"
            rm -rf "$tmp_dir"
            return 1
            ;;
    esac

    case "$arch" in
        x86_64) node_arch="x64" ;;
        aarch64|arm64) node_arch="arm64" ;;
        *)
            echo "Unsupported architecture for user-local Node.js install: $arch"
            rm -rf "$tmp_dir"
            return 1
            ;;
    esac

    version=$(curl -fsSL "$json_url" | grep -m1 '"lts":' | sed -E 's/.*"version":"([^"]+)".*/\1/')
    if [ -z "$version" ]; then
        echo "Failed to determine latest Node.js LTS version"
        rm -rf "$tmp_dir"
        return 1
    fi

    archive_name="node-$version-$os-$node_arch.tar.xz"
    archive_url="https://nodejs.org/dist/$version/$archive_name"

    mkdir -p "$bin_dir"
    curl -fL "$archive_url" -o "$tmp_dir/$archive_name" || {
        rm -rf "$tmp_dir"
        return 1
    }

    tar -C "$tmp_dir" -xf "$tmp_dir/$archive_name" || {
        rm -rf "$tmp_dir"
        return 1
    }

    extracted_dir="$tmp_dir/node-$version-$os-$node_arch"
    if [ ! -d "$extracted_dir" ]; then
        echo "Failed to locate extracted Node.js directory"
        rm -rf "$tmp_dir"
        return 1
    fi

    rm -rf "$install_root"
    mv "$extracted_dir" "$install_root"
    ln -sfn "$install_root/bin/node" "$bin_dir/node"
    ln -sfn "$install_root/bin/npm" "$bin_dir/npm"
    ln -sfn "$install_root/bin/npx" "$bin_dir/npx"
    rm -rf "$tmp_dir"
}

ensure_npm_available() {
    if command -v npm >/dev/null 2>&1; then
        return 0
    fi

    echo "npm is not installed. Codex CLI currently installs via npm."

    case "$(uname -s)" in
        Darwin)
            if command -v brew >/dev/null 2>&1; then
                if prompt_yes_no "Install Node.js (includes npm) with Homebrew for Codex CLI?"; then
                    brew install node
                fi
            else
                if prompt_yes_no "Homebrew is unavailable. Install Node.js user-local under \$HOME/.local for Codex CLI?"; then
                    install_nodejs_user_local
                else
                    return 1
                fi
            fi
            ;;
        Linux)
            if [ -f /etc/lsb-release ] && grep -q "Ubuntu" /etc/lsb-release && can_use_sudo; then
                if command -v apt >/dev/null 2>&1; then
                    if prompt_yes_no "Install Node.js and npm with apt for Codex CLI?"; then
                        sudo apt update
                        sudo apt install -y nodejs npm
                    fi
                elif command -v snap >/dev/null 2>&1; then
                    if prompt_yes_no "Install Node.js (includes npm) with snap for Codex CLI?"; then
                        sudo snap install node --classic
                    fi
                else
                    echo "Neither apt nor snap is available to install Node.js/npm automatically."
                    return 1
                fi
            else
                if prompt_yes_no "Install Node.js user-local under \$HOME/.local for Codex CLI?"; then
                    install_nodejs_user_local
                else
                    return 1
                fi
            fi
            ;;
        *)
            echo "Unsupported OS for automatic Node.js/npm installation."
            return 1
            ;;
    esac

    if ! command -v npm >/dev/null 2>&1; then
        echo "npm is still unavailable. Install Node.js manually, then run: npm install -g @openai/codex"
        return 1
    fi

    return 0
}

install_codex_cli() {
    if ! prompt_yes_no "Install OpenAI Codex CLI?"; then
        return 0
    fi

    if ! ensure_npm_available; then
        return 0
    fi

    npm install -g @openai/codex
}

install_claude_code() {
    if ! prompt_yes_no "Install Claude Code?"; then
        return 0
    fi

    curl -fsSL https://claude.ai/install.sh | bash
}

configure_shell_sources() {
    append_line_if_missing "$PROFILE_FILE" "# General environment variables"
    append_line_if_missing "$PROFILE_FILE" "source \$HOME/env/bash_vars"
    append_line_if_missing "$PROFILE_FILE" "source \$HOME/env/bash_alias"
}

main() {
    cd "$HOME"

    clone_env_repo
    ensure_profile_bootstrap
    symlink_dotfiles

    install_platform_packages
    install_julia_vim

    if prompt_yes_no "Install Neovim binary?"; then
        install_neovim
    fi

    configure_julia_paths
    install_juliaup
    link_julia_projects
    install_spack
    configure_python_workdir
    install_uv
    install_codex_cli
    install_claude_code
    configure_shell_sources

    # shellcheck disable=SC1090
    source "$PROFILE_FILE"
}

main "$@"
