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

echo "## https://github.com/vpuri3/env/bootstrap.sh" >> $HOME/.bash_profile
echo "[ -f $HOME/.bashrc ] && source $HOME/.bashrc"  >> $HOME/.bash_profile

echo "## https://github.com/vpuri3/env/bootstrap.sh" >> $HOME/.bashrc
echo "source $HOME/env/bash_vars"                    >> $HOME/.bashrc
echo "source $HOME/env/bash_alias"                   >> $HOME/.bashrc

ln -sf ~/env/bin ~/bin
chmod +x ~/bin/*

mkdir -p $HOME/.ssh
mkdir -p $HOME/.config/nvim

ln -sf $HOME/env/emacs.conf $HOME/.emacs
ln -sf $HOME/env/vimrc      $HOME/.vimrc
ln -sf $HOME/env/vimrc      $HOME/.config/nvim/init.vim
ln -sf $HOME/env/gitconfig  $HOME/.gitconfig
ln -sf $HOME/env/gitignore  $HOME/.gitignore
ln -sf $HOME/env/tmux.conf  $HOME/.tmux.conf
ln -sf $HOME/env/sshconfig  $HOME/.ssh/config

source ~/.bash_profile
cd $HOME

case `uname` in
Darwin)
	echo "xcode"
	xcode-select -p > /dev/null
	[ "$?" == "0" ] || xcode-select --install

    ## Homebrew
	#if [ -f /opt/homebrew/bin/brew ]; then
	#	/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"")"
	#fi
    #echo "eval "$(/opt/homebrew/bin/brew shellenv)")" >> $HOME/.bash_profile

    case `uname -m` in
        x86*)
            CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh"
            ;;
        arm*)
            CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh"
            ;;
    esac
    SU2_LINK="https://github.com/su2code/SU2/releases/download/v7.4.0/SU2-v7.4.0-macos64-mpi.zip"

	;;
Linux)

    # figure out the right package manager
	#sudo apt-get update
	#sudo apt-get install git unzip wget curl vim imagemagick

    case `uname -m` in
        x86*)
            CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-py39_4.12.0-Linux-x86_64.sh"
            ;;
        *aarch64*)
            CONDA_LINK="https://repo.anaconda.com/miniconda/Miniconda3-py39_4.12.0-Linux-aarch64.sh"
            ;;
    esac
    SU2_LINK="https://github.com/su2code/SU2/releases/download/v7.4.0/SU2-v7.4.0-linux64-mpi.zip"

	;;
esac

## vim
[ ! -d "$HOME/.vim" ] && mkdir $HOME/.vim

## Julia
curl -fsSL https://install.julialang.org | sh # juliaup
[ ! -d $HOME/.julia/config ] && mkdir -p $HOME/.julia/config
ln -sf $HOME/env/startup.jl $HOME/.julia/config/startup.jl

# julia-vim
cd $HOME/.vim
mkdir -p pack/plugins/start && cd pack/plugins/start
git clone https://github.com/JuliaEditorSupport/julia-vim.git

## Spack
if [[ ! -d "$HOME/spack" ]]; then
    git clone https://github.com/spack/spack.git $HOME/spack
    $HOME/share/spack/setup-env.sh
fi

echo "# spack"                                     >> $HOME/.bash_profile
echo "source $HOME/spack/share/spack/setup-env.sh" >> $HOME/.bash_profile

## conda
cd $HOME
CONDA_PATH=$(which conda)
if [[ ! -f "$CONDA_PATH" ]]; then
    echo $CONDA_LINK
    wget $CONDA_LINK
    chmod +x Miniconda3*.sh
    ./Miniconda3*.sh

    echo "# conda" >> $HOME/.bash_profile
    echo "conda config --set auto_activate_base false" >> $HOME/.bash_profile
fi

## NEK
cd $HOME
if [[ ! -d "$HOME/Nek5000" ]]; then
    NEK_LINK="https://github.com/Nek5000/Nek5000/releases/download/v19.0/Nek5000-19.0.tar.gz"
    wget $NEK_LINK
    tar -xvf Nek5000-*.tar.gz > /dev/null # 2 > &1
fi

## SU2
cd $HOME
SU2_CFD_PATH="$(which SU2_CFD)"
if [[ ! -f SU2_CFD_PATH ]]; then
    SU2_HOME="$HOME/SU2"
    SU2_RUN="$SU2_HOME/bin"

    wget $SU2_LINK
    unzip SU2-*.zip -d $SU2_HOME

    echo "# SU2"                                   >> $HOME/.bash_profile
    echo "export SU2_RUN=$SU2_RUN"                 >> $HOME/.bash_profile
    echo "export SU2_HOME=$SU2_HOME"               >> $HOME/.bash_profile
    echo "export PATH=\$PATH:$SU2_RUN"             >> $HOME/.bash_profile
    echo "export PYTHONPATH=\$PYTHONPATH:$SU2_RUN" >> $HOME/.bash_profile
fi

# matlab
cd $HOME
[ ! -d $HOME/matlab ] && mkdir matlab
cd matlab
[ ! -d spec ] && git clone https://github.com/vpuri3/spec.git
ln -sf $HOME/env/startup.m $HOME/matlab/startup.m

# end
eval "source $HOME/.bash_profile"
