#!/bin/bash

cd $HOME

[ ! -d ~/env ] && git clone https://github.com/vpuri3/env.git

touch ~/.bash_profile

echo "# from"											 >> ~/.bash_profile
echo "# //github.com/vpuri3/env/blob/master/bootstrap.sh">> ~/.bash_profile
echo "[ -f ~/.bashrc ] && source ~/.bashrc"              >> ~/.bash_profile
echo "source ~/env/bash_vars"                            >> ~/.bash_profile
echo "source ~/env/bash_alias"                           >> ~/.bash_profile

source ~/.bash_profile

ln -sf ~/env/emacs.conf  ~/.emacs
ln -sf ~/env/vimrc       ~/.vimrc
ln -sf ~/env/gitconfig   ~/.gitconfig
ln -sf ~/env/tmux.conf   ~/.tmux.conf

ln -sf ~/env/bin ~/bin
chmod +x ~/bin/*

case `uname` in
Darwin)
	#echo "python = python3"
	#ln -sf $(which python3) /usr/local/bin/python
	echo "xcode"
	xcode-select -p > /dev/null
	[ "$?" == "0" ] || xcode-select --install

	echo "GCC"
	gccbeclang=$(gcc --version)
	if [[ "$gccbeclang" =~ "clang" ]]; then
		echo "gcc is linked to clang"
		if [[ -x $(which gcc-9) ]]; then
			echo "linking gcc to homebrew gcc-9"
			cd /usr/local/bin
			ln -sf $(which gcc-9)      gcc
			ln -sf $(which g++-9)      g++
			ln -sf $(which gfortran-9) gfortran
		fi
	fi
	;;
Linux)
	sudo apt-get update
	sudo apt-get install install git unzip wget
	;;
esac

cd $HOME

## nek

## matlab
#[ ! -d $HOME/matlab ] && mkdir matlab &&
#cd matlab
#[ ! -d spec ] && git clone https://github.com/vpuri3/spec.git
#ln -sf $HOME/env/startup.m $HOME/matlab/startup.m

cd $HOME
