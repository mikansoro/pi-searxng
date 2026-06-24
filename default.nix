{ runCommandLocal }:
runCommandLocal "pi-searxng" { } ''
                mkdir -p $out
                cp -r ${./.}/. $out/
                ''  
