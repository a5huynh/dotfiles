function ls --wraps lsd --description "alias ls=lsd"
    lsd $argv
end

function ll --wraps lsd --description "alias ll=lsd -l"
    lsd -l $argv
end