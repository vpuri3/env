
## ANL clusters
export NEK_MWD='vpuri@login.mcs.anl.gov:/homes/vpuri'
export NEK_CWD='vpuri@cetus.alcf.anl.gov:/projects/PANDAVal/vpuri'
export NEK_VWD='vpuri@vesta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export NEK_TWD='vpuri@theta.alcf.anl.gov:/projects/wall_turb_dd/vpuri'
export NEK_BWD='ac.vpuri@bebop.lcrc.anl.gov:/lcrc/project/wall_bounded_flows/vpuri'

case `hostname` in
    cooley*)
        export NEK_WD='/lus/theta-fs0/projects/wall_turb_dd/vpuri'
        export PATH=$NEK_WD/Nek5000-v19/bin:$PATH
        ;;
    theta*)
        export NEK_WD='/projects/wall_turb_dd/vpuri'
        export PATH=$NEK_WD/Nek5000-v19/bin:$PATH
        ;;
    cetus*)
        export NEK_WD='/projects/PANDAVal/vpuri'
        ;;
    vesta*)
        export NEK_WD='/projects/wall_turb_dd/vpuri/'
        ;;
    login*)
        export NEK_WD="/homes/vpuri"
        export PATH=$NEK_WD/Nek5000-v19/bin:$PATH
        ;;
    bebop*)
        export NEK_WD='/lcrc/project/wall_bounded_flows/vpuri/'
        ;;
    blues*)
        export NEK_WD='/lcrc/project/wall_bounded_flows/vpuri/'
        ;;
    *ews.illinois.edu)
        MACHINE="ews"
        export MTLB_BIN="/software/matlab-R2017b/bin"
esac

