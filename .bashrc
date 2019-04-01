# utilities
alias     cp='cp -r'
alias    scp='scp -r'
alias    ssh='ssh -Y'
alias     ..='cd ..'
alias     .-='cd -'
alias    cdv='cd $WD; s'
#alias     gr='grep -Irni --color=tty'
alias     pb='pbcopy'
alias     bc='pbpaste'
alias     kk='kill'
alias     ka='killall'
alias     k9='kill -9'
# 
alias     em='emacs -nw'
alias     tm='tmux -new'
alias   mtlb='$MTLB_BIN/matlab -nodesktop'
alias  julia='/Applications/Julia-1.0.app/Contents/Resources/julia/bin/julia'
alias     hs='hugo server'
alias     qs='qstat -u $(whoami)' 
# tail
alias     tl='tail'
alias     tf='tail -f'
alias     le='less'
alias    lel='less logfile'
# git
alias     gs='git status'
alias  gdiff='git diff'
# screen
alias    sls='screen -ls'
alias    sdr='screen -dr'
#. $HOME/Downloads/z-master/z.sh

case `uname` in
Darwin)
	alias      s='ls -lGh'
	alias     la='ls -lGa'
	alias     lt='ls -lGtr'
	alias    cdh='cd $HL; s'
        alias   disp='open /System/Library/PreferencePanes/Displays.prefPane'
        alias   opcr='open -a /Applications/Google\ Chrome.app/'
        # brew
        alias     bu='brew upgrade; brew update'
        alias   bdep='brew deps --tree'
	;;
Linux)
	alias  s='ls -lGh --color=tty'
	alias la='ls -lGa --color=tty'
	alias lt='ls -lGtr --color=tty'
	;;
esac
