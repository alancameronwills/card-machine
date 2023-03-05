#!/bin/bash
while true
do 
	curl -m 10 -s http://localhost:8080/ping >/dev/null
	result=$?
	if test "$result" != "0"
	then
		./restart-server.sh
	fi
	sleep 1200
done
