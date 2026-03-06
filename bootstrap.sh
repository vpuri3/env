#!/bin/bash

cd $HOME

######
# SSH
######

# if [ ! -f $HOME/.ssh/*pub ]; then
#     echo "generating SSH keys"
#     ssh-keygen -t ed25519 -C "vedantpuri@gmail.com"
#     eval "$(ssh-agent -s)"
# 	  ssh-add -K $HOME/.ssh/id_ed25519
# fi

# touch $HOME/.ssh/config
# printf "Host *\n    AddKeysToAgent yes\n    UseKeychain yes\n    IdentityFile ~/.ssh/id_ed25519" > $HOME/.ssh/config

#----------------------------------------------------------------------------#
# load env from git
#----------------------------------------------------------------------------#

[ ! -d ~/env ] && git clone https://github.com/vpuri3/env.git
cd $HOME/env
git remote rm origin
git remote add origin git@github.com:vpuri3/env.git

#----------------------------------------------------------------------------#
# source env/bash_vars, env/bash_alias in ~/.bash_profile
#----------------------------------------------------------------------------#

cd $HOME

touch $HOME/.bash_profile
touch $HOME/.bashrc

echo ""                                             >> $HOME/.bash_profile
echo "# https://github.com/vpuri3/env/bootstrap.sh" >> $HOME/.bash_profile
echo "[ -f $HOME/.bashrc ] && source $HOME/.bashrc" >> $HOME/.bash_profile
echo ""                                             >> $HOME/.bash_profile

#----------------------------------------------------------------------------#
# symlink dotfiles
#----------------------------------------------------------------------------#
chmod +x $HOME/env/bin/*

ln -sf $HOME/env/bin        $HOME/bin
ln -sf $HOME/env/emacs.conf $HOME/.emacs
ln -sf $HOME/env/vimrc      $HOME/.vimrc
ln -sf $HOME/env/gitconfig  $HOME/.gitconfig
ln -sf $HOME/env/gitignore  $HOME/.gitignore
ln -sf $HOME/env/tmux.conf  $HOME/.tmux.conf
ln -sf $HOME/env/condarc    $HOME/.condarc

mkdir -p $HOME/.ssh
ln -sf $HOME/env/sshconfig  $HOME/.ssh/config

[ ! -d "$HOME/.config" ] && mkdir -p $HOME/.config
ln -sf $HOME/env/nvim       $HOME/.config/nvim

source ~/.bash_profile
cd $HOME

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

#----------------------------------------------------------------------------#
case `uname` in
Darwin)

    read -p "Install xcode command line tools? [Y/n] " yn
    case "$yn" in
        [nN]*)
            ;;
        *)
            xcode-select -p > /dev/null
            [ "$?" == "0" ] || xcode-select --install
            ;;
    esac

    read -p "Install Homebrew? [Y/n] " yn
    case "$yn" in
        [nN]*)
            ;;
        *)
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"")"
            echo "# Homebrew"                                >> $HOME./bashrc
            echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> $HOME/.bashrc
            ;;
    esac

    # install utilities
    eval "$(/opt/homebrew/bin/brew shellenv)"
    brew install wget vim

    # disable press-and-hold on Mac
    defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

	;;
Linux)
    
	# Check if we're on Ubuntu
	if [ -f /etc/lsb-release ] && grep -q "Ubuntu" /etc/lsb-release; then
		if command -v apt >/dev/null 2>&1; then
			read -p "Update and install packages on Ubuntu with apt? [Y/n] " yn
			case "$yn" in
				[nN]*)
					;;
				*)
					sudo apt update
					sudo apt list --upgradable
					sudo apt upgrade -y
					sudo apt install -y wget vim python3-pip
					;;
			esac
		elif command -v snap >/dev/null 2>&1; then
			read -p "apt not available. Install packages on Ubuntu with snap? [Y/n] " yn
			case "$yn" in
				[nN]*)
					;;
				*)
					sudo snap refresh
					sudo snap install wget vim
					# Note: python3-pip typically comes with the system or needs different installation
					echo "Note: You may need to install python3-pip separately using your system's package manager"
					;;
			esac
		else
			echo "Neither apt nor snap available on this Ubuntu system"
		fi
	fi

	;;
esac

######
# vim
######

read -p "Install Julia-vim plugin? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        [ ! -d "$HOME/.vim" ] && mkdir -p $HOME/.vim
        cd $HOME/.vim
        mkdir -p pack/plugins/start && cd pack/plugins/start
        git clone https://github.com/JuliaEditorSupport/julia-vim.git # julia-vim
    ;;
esac

######
# neovim
######

read -p "Install Neovim binary? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        install_neovim
    ;;
esac

######
# Julia
######

echo ""        >> $HOME/.bash_profile
echo "# Julia" >> $HOME/.bash_profile

read -p "Set JULIA_DEPOT_PATH? Enter full path. [$HOME/.julia] " dir
case "$dir" in
    [/]*)
        cd $HOME
        echo "export JULIA_DEPOT_PATH=$dir" >> $HOME/.bash_profile
        echo "export JULIAUP_DEPOT_PATH=$dir/juliaup" >> $HOME/.bash_profile
    ;;
    *)
        echo "export JULIA_DEPOT_PATH=$HOME/.julia" >> $HOME/.bash_profile
        echo "export JULIAUP_DEPOT_PATH=$HOME/.julia/juliaup" >> $HOME/.bash_profile
    ;;
esac

echo "alias cdj='cd \$JULIA_DEPOT_PATH/dev; s'" >> $HOME/.bash_profile

read -p "Install Julia via juliaup? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        curl -fsSL https://install.julialang.org | sh # juliaup
        [ ! -d $HOME/.julia/config ] && mkdir -p $HOME/.julia/config
        ln -sf $HOME/env/startup.jl $HOME/.julia/config/startup.jl
    ;;
esac

# set default Julia environment
mkdir -p $JULIA_DEPOT_PATH/environments/v1.9/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.10/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.11/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.12/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.13/

ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.9/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.10/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.11/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.12/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.13/Project.toml

######
# Spack
######

read -p "Install Spack? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        if [[ ! -d "$HOME/spack" ]]; then
            git clone https://github.com/spack/spack.git $HOME/spack
            $HOME/share/spack/setup-env.sh
        fi

        echo ""                                            >> $HOME/.bash_profile
        echo "# spack"                                     >> $HOME/.bash_profile
        echo "source $HOME/spack/share/spack/setup-env.sh" >> $HOME/.bash_profile
    ;;
esac

######
# Set python work directory
######

echo ""         >> $HOME/.bash_profile
echo "# Python" >> $HOME/.bash_profile

read -p "Set Python work directory? Enter full path. [$HOME/python] " dir
case "$dir" in
    [/]*)
        cd $HOME
        echo "export PY_WD=$dir" >> $HOME/.bash_profile
    ;;
    *)
        echo "export PY_WD=$HOME/python" >> $HOME/.bash_profile
    ;;
esac

echo "alias cdp='cd \$PY_WD; s'" >> $HOME/.bash_profile

######
# uv
######

if ! command -v uv &> /dev/null; then
    read -p "Install uv? [Y/n] " yn
    case "$yn" in
        [nN]*)
        ;;
        *)
            echo "Installing uv..."
            curl -LsSf https://astral.sh/uv/install.sh | sh
            uv self update
        ;;
    esac
else
    echo "uv is already installed, skipping installation"
fi

#----------------------------------------------------------------------------#

######
# end
######

echo ""                                >> $HOME/.bash_profile
echo "# General environment variables" >> $HOME/.bash_profile
echo "source $HOME/env/bash_vars"      >> $HOME/.bash_profile
echo "source $HOME/env/bash_alias"     >> $HOME/.bash_profile
echo ""                                >> $HOME/.bash_profile

eval "source $HOME/.bash_profile"
#
