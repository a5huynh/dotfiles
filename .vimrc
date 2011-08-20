" Necessary for lots of cool vim things
set nocompatible

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
set grepprg=grep\ -nH\ $*

set t_Co=256
set background=dark

" Me favorite font
set guifont=Inconsolata:h14

" Keep backups and temporary files in one place.
" We NEED to create these directories first.
set backup
set backupdir=~/.vim/backup
set directory=~/.vim/tmp
