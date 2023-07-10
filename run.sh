#!/bin/bash
cd `dirname $BASH_SOURCE`

# Archive logs
(
	mkdir -p logs
 	mv -f log-server.log logs/log-server-`date +%d`.log 

 	case `date +%d` in (01) # on 1st of month

		mv -f log-update.log logs/log-update-`date +%m`.log 

		# Truncate sales record
		tail -q --lines=500 log-donations.txt > log-donations-1.txt 
		mv -f log-donations-1.txt log-donations.txt
	esac 
) &

# Copy latest code from git folder
if test -d ~/src/card-machine ;
then
	cp -ruv ~/src/card-machine/* ~/card-machine
fi

# Allow WiFi router to start
sleep 1m

# Download latest code
while true
do
	sleep 10m
	./fetch-code.sh
	sleep 11h
done >> log-update.log 2>&1 &

# Start server and client
(cd server; ./server.sh) >>log-server.log 2>&1 &
(sleep 10s; chromium-browser --kiosk --no-first-run --disable-infobars --disable-pinch --start-fullscreen --disk-cache-size=1 http://localhost:8080/?nocursor) 

read -t 30 -p "--"
