echo `date` " restart server" 
kill `ps x | grep server | grep 8080 | sed "s/^ *\([0-9]*\).*$/\1/"`
node server.js 8080 &
