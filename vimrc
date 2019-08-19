syntax on

set autoread

set ignorecase
set smartcase

set autoindent
set noerrorbells

set ruler
set incsearch
set hlsearch
set showmatch

set tabstop=4
set splitright

"set  timeoutlen=1000
set ttimeoutlen=0

au BufRead .gitconfig,gitconfig setf make
au BufRead *.usr setf fortran
au BufRead SIZE setf fortran

map <C-E> 2w
map <C-B> 2b
nnoremap Y y$
