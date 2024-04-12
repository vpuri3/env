#!/bin/bash

cd $HOME
## SSH
#if [ ! -f $HOME/.ssh/*pub ]; then
#    echo "generating SSH keys"
#    ssh-keygen -t ed25519 -C "vedantpuri@gmail.com"
#    eval "$(ssh-agent -s)"
#fi

#ssh-add -K $HOME/.ssh/id_ed25519

#touch $HOME/.ssh/config
#printf "Host *\n    AddKeysToAgent yes\n    UseKeychain yes\n    IdentityFile ~/.ssh/id_ed25519" > $HOME/.ssh/config

[ ! -d ~/env ] && git clone https://github.com/vpuri3/env.git
cd $HOME/env
git remote rm origin
git remote add origin git@github.com:vpuri3/env.git

cd $HOME

touch $HOME/.bash_profile
touch $HOME/.bashrc

echo ""                                             >> $HOME/.bash_profile
echo "# https://github.com/vpuri3/env/bootstrap.sh" >> $HOME/.bash_profile
echo "[ -f $HOME/.bashrc ] && source $HOME/.bashrc" >> $HOME/.bash_profile

echo ""                                             >> $HOME/.bashrc
echo "# https://github.com/vpuri3/env/bootstrap.sh" >> $HOME/.bashrc
echo "source $HOME/env/bash_vars"                   >> $HOME/.bashrc
echo "source $HOME/env/bash_alias"                  >> $HOME/.bashrc
echo ""                                             >> $HOME/.bashrc

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
    brew install wget, vim, nvim

    # disable press-and-hold on Mac
    defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

	;;
Linux)

    # figure out the right package manager
	#sudo apt-get update
	#sudo apt-get install git unzip wget curl vim imagemagick
	;;
esac

## vim
[ ! -d "$HOME/.vim" ] && mkdir -p $HOME/.vim
cd $HOME/.vim
mkdir -p pack/plugins/start && cd pack/plugins/start
git clone https://github.com/JuliaEditorSupport/julia-vim.git # julia-vim

######
# neovim
######
read -p "Install Neovim binary? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        cd $HOME
        echo ""       >> $HOME/.bash_profile
        echo "# nvim" >> $HOME/.bash_profile
        case `uname` in
            Darwin)
                curl -LO https://github.com/neovim/neovim/releases/download/nightly/nvim-macos.tar.gz
                tar xzf nvim-macos.tar.gz $HOME/nvim-macos/bin/nvim
                echo "alias nvim='$HOME/nvim-macos/bin/nvim'" >> $HOME/.bash_profile
                ;;
            Linux)
                curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim.appimage
                chmod u+x nvim.appimage $HOME/nvim.appimage
                echo "alias nvim='$HOME/nvim.appimage'" >> $HOME/.bash_profile
                ;;
        esac
    ;;
esac

######
# Julia
######
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

echo ""        >> $HOME/.bash_profile
echo "# Julia" >> $HOME/.bash_profile

read -p "Set Julia development directory? Enter full path. [$HOME/.julia/dev] " dir
case "$dir" in
    [/]*)
        cd $HOME
        if [[ -d "$dir" ]]; then
            echo "export JULIA_PKG_DEVDIR=$dir" >> $HOME/.bash_profile
        else
            echo "$dir not valid directory"
            exit 1
        fi
    ;;
    *)
        echo "export JULIA_PKG_DEVDIR=$HOME/.julia/dev" >> $HOME/.bash_profile
    ;;
esac

echo "alias cdj='cd \$JULIA_PKG_DEVDIR; s'" >> $HOME/.bash_profile

read -p "Set Julia depot path? Enter full path. [$HOME/.julia] " dir
case "$dir" in
    [/]*)
        cd $HOME
        if [[ -d "$dir" ]]; then
            echo "export JULIA_DEPOT_PATH=$dir" >> $HOME/.bash_profile
        else
            echo "$dir not valid directory"
            exit 1
        fi
        JULIA_DEPOT_PATH="$dir"
    ;;
    *)
        echo "export JULIA_DEPOT_PATH=$HOME/.julia" >> $HOME/.bash_profile
        JULIA_DEPOT_PATH="$HOME/.julia"
    ;;
esac

# set default Julia environment
mkdir -p $JULIA_DEPOT_PATH/environments/v1.9/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.10/
mkdir -p $JULIA_DEPOT_PATH/environments/v1.11/

ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.9/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.10/Project.toml
ln -f $HOME/env/JL_Project.toml $JULIA_DEPOT_PATH/environments/v1.11/Project.toml

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
# conda
######
read -p "Install Miniconda3? [Y/n] " yn
case "$yn" in
    [nN]*)
    ;;
    *)
        case `uname` in
            Darwin)
                case `uname -m` in
                    x86*) CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh"
                        ;;
                    arm*) CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh"
                        ;;
                esac
                ;;
            Linux)
                case `uname -m` in
                    x86*) CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-py39_4.12.0-Linux-x86_64.sh"
                        ;;
                    *aarch64*) CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-py39_4.12.0-Linux-aarch64.sh"
                        ;;
                esac
                ;;
        esac

        cd $HOME
        CONDA_PATH=$(which conda)
        if [[ ! -f "$CONDA_PATH" ]]; then
            echo $CONDA_LINK
            wget $CONDA_LINK
            chmod +x Miniconda3*.sh
            ./Miniconda3*.sh

            echo ""        >> $HOME/.bash_profile
            echo "# conda" >> $HOME/.bash_profile
        fi
    ;;
esac

######
# NEK5000
######
read -p "Install Nek5000? [y/N] " yn
case "$yn" in
    [yY]*)
        cd $HOME
        if [[ ! -d "$HOME/Nek5000" ]]; then
            NEK_LINK="https://github.com/Nek5000/Nek5000/releases/download/v19.0/Nek5000-19.0.tar.gz"
            wget $NEK_LINK
            tar -xvf Nek5000-*.tar.gz > /dev/null # 2 > &1
        fi
        echo ""                                     >> $HOME/.bash_profile
        echo "# Nek5000"                            >> $HOME/.bash_profile
        echo "export PATH=$HOME/Nek5000/bin:\$PATH" >> $HOME/.bash_profile
    ;;
    *)
    ;;
esac

######
# SU2
######
read -p "Install SU2? [y/N] " yn
case "$yn" in
    [Yy]*)
        case `uname` in
            Darwin) SU2_LINK="https://github.com/su2code/SU2/releases/download/v7.4.0/SU2-v7.4.0-macos64-mpi.zip"
                ;;
            Linux) SU2_LINK="https://github.com/su2code/SU2/releases/download/v7.4.0/SU2-v7.4.0-linux64-mpi.zip"
                ;;
        esac

        cd $HOME
        SU2_CFD_PATH="$(which SU2_CFD)"
        if [[ ! -f SU2_CFD_PATH ]]; then
            SU2_HOME="$HOME/SU2"
            SU2_RUN="$SU2_HOME/bin"

            wget $SU2_LINK
            unzip SU2-*.zip -d $SU2_HOME

            echo ""                                        >> $HOME/.bash_profile
            echo "# SU2"                                   >> $HOME/.bash_profile
            echo "export SU2_RUN=$SU2_RUN"                 >> $HOME/.bash_profile
            echo "export SU2_HOME=$SU2_HOME"               >> $HOME/.bash_profile
            echo "export PATH=\$PATH:$SU2_RUN"             >> $HOME/.bash_profile
            echo "export PYTHONPATH=\$PYTHONPATH:$SU2_RUN" >> $HOME/.bash_profile
        fi
    ;;
    *)
    ;;
esac

######
# matlab
######
cd $HOME
[ ! -d $HOME/matlab ] && mkdir matlab
cd matlab
[ ! -d spec ] && git clone https://github.com/vpuri3/spec.git
ln -sf $HOME/env/startup.m $HOME/matlab/startup.m

## PETSc
# export PETSC_DIR=/Users/vp/software/petsc
# export PETSC_ARCH=arch-darwin-c-debug

## Visit
# export PATH=/Applications/VisIt.app/Contents/MacOS:$PATH

######
# end
######
eval "source $HOME/.bash_profile"
