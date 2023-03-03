#!/bin/bash
cd server
while true
do 
	curl -m 10 -s http://localhost:8080/ping >/dev/null
	result=$?
	if test "$result" != "0"
	then
		echo `date` " restart server" 
		kill `ps x | grep server | grep 8080 | sed "s/^ *\([0-9]*\).*$/\1/"`
		node server.js 8080 &
	fi
	sleep 1200
done
