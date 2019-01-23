#export PATH='/usr/bin:/bin:/usr/sbin:/sbin:/Library/TeX/texbin'

# Load .bashrc (if exists)
test -f ~/.bashrc && source ~/.bashrc

# PS1
export PS1='[\[\e[0;32m\]\u\[\e[1;36m\]@\T\[\e[0m\] \W]:'

# Ensure user-installed binaries take precedence
export PATH=/usr/local/bin:$PATH

# Nek5000
export PATH=$HOME/Nek5000/bin:$PATH

# misc
export PATH=$HOME/bin:$PATH

# email
export email="vpuri3@illinois.edu"
export WD=$HOME'/Nek5000/run'
export QSTAT_HEADER="JobId:User:RunTime:WallTime:State:Location:Nodes"

# clusters
export BWD='vpuri@bebop.lcrc.anl.gov:/lcrc/project/wall_bounded_flows/vpuri'
export VWD='vpuri@vesta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export MWD='vpuri@login.mcs.anl.gov:/homes/vpuri'

case `uname` in
Darwin)
# brew
	export PATH=/usr/local/sbin:$PATH
	# MPICH
	export PATH=$HOME/software/mpich-3.2.1/mpich-install/bin:$PATH
	# PETSc
	export PETSC_DIR=/Users/vedantpuri/software/petsc
	export PETSC_ARCH=arch-darwin-c-debug
	# Visit
	export PATH=/Applications/VisIt.app/Contents/MacOS:$PATH
	;;
Linux)
	;;
esac