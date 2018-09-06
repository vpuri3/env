#export PATH='/usr/bin:/bin:/usr/sbin:/sbin:/Library/TeX/texbin'

# PS1
export PS1='[\[\e[0;32m\]\u\[\e[1;36m\]@\h\[\e[0m\] \W]:'

# Load .bashrc (if exists)
test -f ~/.bashrc && source ~/.bashrc

# Ensure user-installed binaries take precedence
export PATH=/usr/local/bin:$PATH

# set gcc-8,g++-8,gfortran-8 as gcc,g++,gfortran resp.
ln -shf /usr/local/bin/gcc-8      /usr/local/bin/gcc
ln -shf /usr/local/bin/g++-8      /usr/local/bin/g++
ln -shf /usr/local/bin/gfortran-8 /usr/local/bin/gfortran

# MPICH
export PATH=$HOME/software/mpich-3.2.1/mpich-install/bin:$PATH

# PETSc
export PETSC_DIR=/Users/vedantpuri/software/petsc
export PETSC_ARCH=arch-darwin-c-debug

# Nek5000
export PATH=$HOME/Nek5000/bin:$PATH

# Visit
export PATH=/Applications/VisIt.app/Contents/MacOS:$PATH

# misc
export PATH=$HOME/bin:$PATH

# clusters
export BWD='vpuri@bebop.lcrc.anl.gov:/lcrc/project/wall_bounded_flows/vpuri'
export VWD='vpuri@vesta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export MWD='vpuri@login.mcs.anl.gov:/homes/vpuri'

export  WD='~/Nek5000/run'