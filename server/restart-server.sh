echo `date` " restart server" 
process=`ps x | grep server | grep 8080 | sed "s/^ *\([0-9]*\).*$/\1/"`
if [ -n "$process" ]; then kill $process ; fi 
node server.js 8080 &
