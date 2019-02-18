#export PATH='/usr/bin:/bin:/usr/sbin:/sbin:/Library/TeX/texbin'

# Load .bashrc (if exists)
[ -f ~/.bashrc ] && source ~/.bashrc

# PS1
machine=$(hostname)
[ $(uname) = "Darwin" ] && machine="MacBookPro"
export PS1='[\[\e[0;32m\]vp\[\e[1;36m\]@$machine\[\e[0m\] \W]:'

# Nek
export PATH=$HOME/Nek5000/bin:$PATH

# scripts
export PATH=$HOME/bin:$PATH

# vars
export email="vpuri3@illinois.edu"
export QSTAT_HEADER="JobId:User:RunTime:WallTime:State:Location:Nodes"
export TZ="America/Chicago"
export EDITOR="vi"

# clusters
export BWD='vpuri@bebop.lcrc.anl.gov:/lcrc/project/wall_bounded_flows/vpuri'
export VWD='vpuri@vesta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export MWD='vpuri@login.mcs.anl.gov:/homes/vpuri'

case `uname` in
Darwin)
	#Ensure user-installed binaries take precedence
	export PATH=/usr/local/bin:$PATH
	# brew
	export PATH=/usr/local/sbin:$PATH
	# MPICH
	#export PATH=$HOME/software/mpich-3.2.1/mpich-install/bin:$PATH
	# PETSc
	export PETSC_DIR=/Users/vedantpuri/software/petsc
	export PETSC_ARCH=arch-darwin-c-debug
	# Visit
	export PATH=/Applications/VisIt.app/Contents/MacOS:$PATH
	# MATLAB
	ln -fs /Applications/MATLAB_R2018b.app/bin/matlab /usr/local/bin/matlab
	# NEK
	export WD=$HOME'/Nek5000/run'
	# ME 470
	export HL=$HOME'/matlab/hl'
	;;
Linux)
	case `hostname` in
	vesta*)
		export WD='/projects/wall_turb_dd/vpuri/'
		;;
	login*)
		export WD="/homes/vpuri"
		;;
	bebop*)
		export WD='/lcrc/project/waall_bounded_flows/vpuri/'
		;;
	esac
	;;
esac

