#!/bin/bash
cd `dirname $BASH_SOURCE`
(	# Archive logs
	mkdir -p logs
 	mv -f log-server.log logs/log-server-`date +%d`.log 
 	case `date +%d` in (01) mv -f log-update.log logs/log-update-`date +%m`.log ; esac 
) &
sleep 1m # Allow WiFi router to start
while true
do
	sleep 10m
	./fetch-code.sh
	sleep 8h
done >> log-update.log 2>&1 &
(cd server; ./server.sh) >>log-server.log 2>&1 &
(sleep 10s; chromium-browser --kiosk --no-first-run --disable-infobars --disable-pinch --start-fullscreen --disk-cache-size=1 http://localhost:8080/?nocursor) 
read -t 30 -p "--"
