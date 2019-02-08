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
alias     ka='killall'
alias     k9='kill -9'
# 
alias     em='emacs -nw'
alias     tm='tmux -new'
alias   mtlb='matlab -nodesktop'
alias  julia='/Applications/Julia-1.0.app/Contents/Resources/julia/bin/julia'
alias     hs='hugo server'
alias chrome='/Applications/Google\ Chrome.app/'
alias     qs='qstat --header JobId:User:RunTime:WallTime:State:Location:Nodes'
# tail
alias     tl='tail'
alias     tf='tail -f'
# alias    tfl='tail -f logfile'
alias     le='less'
alias    lel='less logfile'
# brew
alias     bu='brew upgrade; brew update'
alias   bdep='brew deps --tree'
# git
alias     gs='git status'
alias  gdiff='git diff'
# screen
alias    sls='screen -ls'
alias    sdr='screen -dr'
#. $HOME/Downloads/z-master/z.sh

case `uname` in
Darwin)
	alias   s='ls -lGh'
	alias  la='ls -lGa'
	alias  lt='ls -lGtr'
	alias cdh='cd $HL; s'
	;;
Linux)
	alias  s='ls -lGh --color=tty'
	alias la='ls -lGa --color=tty'
	alias lt='ls -lGtr --color=tty'
	;;
esac