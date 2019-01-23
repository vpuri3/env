alias     cp='cp -r'
alias    scp='scp -r'
alias     em='emacs -nw'
alias     le='less'
alias     pb='pbcopy'
alias     bc='pbpaste'
alias    ssh='ssh -Y'
alias     ka='killall'
alias     k9='kill -9'
alias    cdv='cd $WD'
alias     tl='tail'
alias     tf='tail -f'
alias    tfl='tail -f logfile'
alias    lel='less logfile'
alias     gr='grep -Irni --color=tty'
alias     ..='cd ..'
alias     .-='cd -'
alias     tm='tmux -new'
alias     bu='brew upgrade; brew update'
alias   bdep='brew deps --tree'
alias matlab='/Applications/MATLAB_R2017b.app/bin/matlab -nodesktop'
alias  julia='/Applications/Julia-1.0.app/Contents/Resources/julia/bin/julia'
alias     hs='hugo server'
alias chrome='/Applications/Google\ Chrome.app/'
alias     qs='qstat --header JobId:User:RunTime:WallTime:State:Location:Nodes'
alias     gs='git status'
alias  gdiff='git diff'
alias    sls='screen -ls'
alias    sdr='screen -dr'
#. $HOME/Downloads/z-master/z.sh

case `uname` in
Darwin)
	alias  s='ls -lGh'
	alias la='ls -lGa'
	alias lt='ls -lGtr'
	;;
Linux)
	alias  s='ls -lGh --color=tty'
	alias la='ls -lGa --color=tty'
	alias lt='ls -lGtr --color=tty'
	;;
esac