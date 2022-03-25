#!/bin/bash

echo "bash script to load environment variables. Don't forget to"
echo "$ source ~/.bash_profile afterwards"

cd $HOME

[ ! -d ~/env ] && git clone https://github.com/vpuri3/env.git

touch $HOME/.bash_profile

echo "## https://github.com/vpuri3/env/bootstrap.sh" >>~/.bash_profile
echo "[ -f $HOME/.bashrc ] && source ~/.bashrc"      >>~/.bash_profile
echo "source $HOME/env/bash_vars"                    >>~/.bash_profile
echo "source $HOME/env/bash_alias"                   >>~/.bash_profile
echo "# Spack"                                       >>~/.bash_profile
echo "$source HOME/spack/share/spack/setup-env.sh"   >>~/.bash_profile

ln -sf ~/env/emacs.conf  ~/.emacs
ln -sf ~/env/vimrc       ~/.vimrc
ln -sf ~/env/gitconfig   ~/.gitconfig
ln -sf ~/env/tmux.conf   ~/.tmux.conf

ln -sf ~/env/bin ~/bin
chmod +x ~/bin/*

source ~/.bash_profile
cd $HOME

case `uname` in
Darwin)
	echo "xcode"
	xcode-select -p > /dev/null
	[ "$?" == "0" ] || xcode-select --install

    # Comment out Homebrew part. switch to spack
    : '
	# homebrew
	if [ -f /usr/local/bin/brew ]; then
		/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"")"

	    # get essentials
        brew install python
        brew install python@3.7

        # link python, pip to homebrew python@3.7
        ln -sf $(which python3.7) /usr/local/bin/python
        ln -sf $(which pip.7)     /usr/local/bin/pip

	    brew install vim

	    echo "Ensure gcc is not linked to clang"

	    gccbeclang=$(gcc --version)
	    if [[ "$gccbeclang" =~ "clang" ]]; then
	    	echo "gcc is linked to clang"
	    	if [[ -x $(which gcc) ]]; then
	    		echo "linking gcc to homebrew gcc"
	    		cd /usr/local/bin
	    		ln -sf $(which gcc)      gcc
	    		ln -sf $(which g++)      g++
	    		ln -sf $(which gfortran) gfortran
	    	fi
	    fi

	fi
    '
    # end comment

    ## Julia
    JL_PATH=$(which julia)
    if [[ ! -f "$JL_PATH" ]] ; then
        cd $HOME
        case `uname -m` in
            x86*)
                JL_LINK="https://julialang-s3.julialang.org/bin/mac/x64/1.7/julia-1.7.2-mac64.tar.gz"
                ;;
            arm*)
                JL_LINK="https://julialang-s3.julialang.org/bin/mac/aarch64/1.7/julia-1.7.2-macaarch64.dmg"
                ;;
        esac
        wget $JL_LINK
        tar -xvf julia-*.tar.gz > /dev/null # 2 > &1
    fi

	;;
Linux)

    # figure out the right package manager

	#sudo apt-get update
	#sudo apt-get install git unzip wget curl vim

    ## Julia
    JL_PATH=$(which julia)
    if [[ ! -f "$JL_PATH" ]] ; then
        cd $HOME
        case `uname -m` in
            x86*)
                JL_LINK="https://julialang-s3.julialang.org/bin/linux/x64/1.7/julia-1.7.2-linux-x86_64.tar.gz"
                ;;
            *aarch64*)
                JL_LINK="https://julialang-s3.julialang.org/bin/linux/aarch64/1.7/julia-1.7.2-linux-aarch64.tar.gz"
                ;;
        esac
        wget $JL_LINK
        tar -xvf julia-*.tar.gz > /dev/null # 2 > &1
    fi

	;;
esac

## vim
[ ! -d "$HOME/.vim" ] && mkdir $HOME/.vim

# vim pathogen
if [ ! -d "$HOME/.vim/autoloaded/pathogen.vim" ]; then
	mkdir -p $HOME/.vim/autoload $HOME/.vim/bundle && \
	curl -LSso $HOME/.vim/autoload/pathogen.vim https://tpo.pe/pathogen.vim
fi

# julia-vim
if [[ ! -d "$HOME/.vim/bundle/julia-vim" ]]; then
    git clone https://github.com/JuliaEditorSupport/julia-vim.git \
    $HOME/.vim/bundle/julia-vim
fi

## Julia
[ ! -d $HOME/.julia/config ] && mkdir -p $HOME/.julia/config
ln -sf $HOME/env/startup.jl $HOME/.julia/config/startup.jl

## nek
if [[ ! -d "$HOME/Nek5000" ]]; then
    NEK_LINK="https://github.com/Nek5000/Nek5000/releases/download/v19.0/Nek5000-19.0.tar.gz"
    wget $NEK_LINK
    tar -xvf Nek5000-*.tar.gz > /dev/null # 2 > &1
fi

## Spack
if [[ ! -d "$HOME/spack" ]]; then
    git clone https://github.com/spack/spack.git $HOME/spack
    $HOME/share/spack/setup-env.sh
fi

## matlab
#[ ! -d $HOME/matlab ] && mkdir matlab
#cd matlab
#[ ! -d spec ] && git clone https://github.com/vpuri3/spec.git
#ln -sf $HOME/env/startup.m $HOME/matlab/startup.m

## end
