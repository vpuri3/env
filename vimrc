"
execute pathogen#infect()

syntax on
filetype plugin indent on

set omnifunc=syntaxcomplete#Complete

set nocompatible
set autoread

set ignorecase
set smartcase

set autoindent
set noerrorbells

set ruler
" set number

set incsearch
set hlsearch
set showmatch

set splitright
set splitbelow

set autochdir

set fileformat=unix
set encoding=utf-8
set fileencoding=utf-8

" split-screen
nnoremap <C-J> <C-W><C-J>
nnoremap <C-K> <C-W><C-K>
nnoremap <C-L> <C-W><C-L>
nnoremap <C-H> <C-W><C-H>

" vim tabs
:command T tabe
map <C-P> :tabp<cr>
map <C-N> :tabn<cr>

map <C-E> 2w
map <C-B> 2b

"map k gk
"map j gj

nnoremap Y y$

" open/close parentheses
inoremap " ""<left>
inoremap ' ''<left>
inoremap ( ()<left>
inoremap [ []<left>
inoremap { {}<left>
inoremap {<CR> {<CR>}<ESC>O
inoremap {;<CR> {<CR>};<ESC>O))

set  timeoutlen=1000
set ttimeoutlen=0

au BufRead .gitconfig,gitconfig setf make
au BufRead SIZE  setf fortran " nek
au BufRead *.usr setf fortran " nek
au BufRead *.geo setf c       " gmsh

set tabstop=4
set shiftwidth=4
set softtabstop=4
set expandtab

autocmd FileType make    set tabstop=2 shiftwidth=8 softtabstop=0
autocmd FileType fortran set tabstop=2 shiftwidth=2 softtabstop=2

set path+=**
set wildmenu


colorscheme default "desert,peachpuff


