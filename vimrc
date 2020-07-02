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
set splitbelow

set autochdir

" split-screen
nnoremap <C-J> <C-W><C-J>
nnoremap <C-K> <C-W><C-K>
nnoremap <C-L> <C-W><C-L>
nnoremap <C-H> <C-W><C-H>

" tabs
:command T tabe
map <C-P> :tabp<cr>
map <C-N> :tabn<cr>

set  timeoutlen=1000
set ttimeoutlen=0

au BufRead .gitconfig,gitconfig setf make
au BufRead *.usr setf fortran
au BufRead SIZE setf fortran

autocmd FileType make set noexpandtab shiftwidth=8 softtabstop=0
autocmd FileType fortran set tabstop=3 shiftwidth=3 softtabstop=3

map <C-E> 2w
map <C-B> 2b

"map k gk
"map j gj

nnoremap Y y$
