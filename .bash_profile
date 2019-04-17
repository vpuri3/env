# Load .bashrc (if exists)
[ -f ~/.bashrc ] && source ~/.bashrc

# scripts
export PATH=$HOME/bin:$PATH

# Nek
export PATH=$HOME/Nek5000/bin:$PATH

# vars
export email="vpuri3@illinois.edu"
export QSTAT_HEADER="JobId:User:RunTime:WallTime:State:Location:Nodes"
export TZ="America/Chicago"
export EDITOR="vi"

# clusters
export MWD='vpuri@login.mcs.anl.gov:/homes/vpuri'
export CWD='vpuri@cetus.alcf.anl.gov:/projects/PANDAVal/vpuri'
export VWD='vpuri@vesta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export BWD='vpuri@bebop.lcrc.anl.gov:/lcrc/project/wall_bounded_flows/vpuri'
export EWD='vpuri3@linux.ews.illinois.edu:/home/vpuri3'

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
	export MTLB_BIN="/Applications/MATLAB_R2019a.app/bin"
	# NEK
	export WD=$HOME'/Nek5000/run'
	# ME 470
	export HL=$HOME'/matlab/hl'
	# PS1
	machine="MacBookPro"
	;;
Linux)
	machine=$(hostname)
	case `hostname` in
	cetus*)
		export WD='/projects/PANDAVal/vpuri'
		;;
	vesta*)
		export WD='/projects/wall_turb_dd/vpuri/'
		;;
	login*)
		export WD="/homes/vpuri"
		;;
	bebop*)
		export WD='/lcrc/project/waall_bounded_flows/vpuri/'
		;;
	*ews.illinois.edu)
		machine="ews"
	        export MTLB_BIN="/software/matlab-R2017b/bin"
	esac
	;;
esac

# PS1
export PS1='[\[\e[0;32m\]vp\[\e[1;36m\]@$machine\[\e[0m\] \W]:'
