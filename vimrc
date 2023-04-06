"
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
:command TT tab terminal
map <C-P> :tabp<cr>
map <C-N> :tabn<cr>

map <C-E> 2w
map <C-B> 2b

"map k gk
"map j gj

nnoremap Y y$

" open/close parentheses
"inoremap " ""<left>
"inoremap ' ''<left>
inoremap ( ()<left>
inoremap [ []<left>
inoremap { {}<left>
" inoremap < <><left>
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


colorscheme default
highlight Visual ctermfg=Black ctermbg=Yellow cterm=NONE

" youcompleteme
au bufenter *jl let g:ycm_auto_trigger=0


"
" TERMINAL navigation help
"
" Use ctrl-w N to switch to "terminal-normal mode", which will let you
" navigate around. It could be useful to then copy content to the clipboard.
" Then return to regular terminal mode, simply type i just like how you'd
" enter insert mode from a regular window.
"
"ctrl-w : will open command mode like in regular Vim.
"
"ctrl-w "" will paste, which is useful if you want to enter something from a
"file in another window. More generally, you can paste recent or saved
"clipboard contents using :ctrl-w " {reg}, where reg identifies the register
"to paste. Type ctrl-w :display (or ctrl-w :dis) to see all available
"registers and their content.
"
"
