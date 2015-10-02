" Necessary for lots of cool vim things
set nocompatible
filetype off

" Set the runtime path to include Vundle and initialize
set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()

" Let Vundle manage Vundle
Plugin 'VundleVim/Vundle.vim'
" Git wrapper
Plugin 'tpope/vim-fugitive'
" Lightweight vim status bar
Plugin 'bling/vim-airline'
" Fuzzy match
Plugin 'kien/ctrlp.vim'

Plugin 'godlygeek/tabular'
Plugin 'plasticboy/vim-markdown'

" All vundle plugins must be added before here
call vundle#end()

" Setup vim-airline
set laststatus=2
let g:airline#extensions#tabline#enabled=1

" Tabby McTabby
set tabstop=4
set shiftwidth=4
set softtabstop=4
set expandtab
set smarttab
set autoindent

" Turn on line numbers
set number

" This shows what you are typing as a command.
set showcmd

" Turn off annoying error bells
set noerrorbells
set visualbell
set t_vb=

" === Theming stuff ====
" Needed for syntax highlighting and stuff
filetype on
filetype plugin on
syntax on
colorscheme solarized
set grepprg=grep\ -nH\ $*

set t_Co=256
set background=dark

" Me favorite font
set guifont=Source\ Code\ Pro:h14

" Keep backups and temporary files in one place.
" We NEED to create these directories first.
set backup
set backupdir=~/.vim/backup
set directory=~/.vim/tmp
