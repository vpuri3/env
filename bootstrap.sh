#!/bin/bash

echo "bash script to load environment variables. Don't forget to"
echo "$ source ~/.bash_profile afterwards"

cd $HOME

[ ! -d ~/env ] && git clone https://github.com/vpuri3/env.git

touch ~/.bash_profile

echo "# https://github.com/vpuri3/env/bootstrap.sh" >>~/.bash_profile
echo "[ -f ~/.bashrc ] && source ~/.bashrc"         >>~/.bash_profile
echo "source ~/env/bash_vars"                       >>~/.bash_profile
echo "source ~/env/bash_alias"                      >>~/.bash_profile

source ~/.bash_profile

ln -sf ~/env/emacs.conf  ~/.emacs
ln -sf ~/env/vimrc       ~/.vimrc
ln -sf ~/env/gitconfig   ~/.gitconfig
ln -sf ~/env/tmux.conf   ~/.tmux.conf

ln -sf ~/env/bin ~/bin
chmod +x ~/bin/*

cd $HOME

case `uname` in
Darwin)
	echo "xcode"
	xcode-select -p > /dev/null
	[ "$?" == "0" ] || xcode-select --install

	# homebrew
	if [ -f /usr/local/bin/brew ]; then
		/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"")"

	    # get essentials
        brew install python
        brew install python@3.7

        # link python, pip to homebrew's python@3.7
        ln -sf $(which python3.7) /usr/local/bin/python
        ln -sf $(which pip.7)     /usr/local/bin/pip

	    brew install vim

	    echo "Ensure gcc is not linked to clang"

	    gccbeclang=$(gcc --version)
	    if [[ "$gccbeclang" =~ "clang" ]]; then
	    	echo "gcc is linked to clang"
	    	if [[ -x $(which gcc) ]]; then
	    		echo "linking gcc to homebrew's gcc"
	    		cd /usr/local/bin
	    		ln -sf $(which gcc)      gcc
	    		ln -sf $(which g++)      g++
	    		ln -sf $(which gfortran) gfortran
	    	fi
	    fi

	fi

	;;
Linux) # make cases for yum (redheat), apt
	#sudo apt-get update
	#sudo apt-get install git unzip wget vim
	;;
esac

# vim
[ ! -d ~/.vim ] && mkdir $HOME/.vim

# vim pathogen
if [ ! -d ~/.vim/autoloaded/pathogen.vim ]; then
	mkdir -p ~/.vim/autoload ~/.vim/bundle && \
	curl -LSso ~/.vim/autoload/pathogen.vim https://tpo.pe/pathogen.vim

	# Julia vim
	git clone git://github.com/JuliaEditorSupport/julia-vim.git \
	~/.vim/bundle/julia-vim

fi

## julia
[ ! -d $HOME/.julia/config ] && mkdir $HOME/.julia/config
ln -sf $HOME/env/startup.jl $HOME/.julia/config/startup.jl

## nek

## python

## matlab
#[ ! -d $HOME/matlab ] && mkdir matlab
#cd matlab
#[ ! -d spec ] && git clone https://github.com/vpuri3/spec.git
#ln -sf $HOME/env/startup.m $HOME/matlab/startup.m

cd $HOME
