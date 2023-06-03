#!/bin/bash
sleep 1m
cd `dirname $BASH_SOURCE`
while true
do
	sleep 10m
	./update-code.sh
	sleep 8h
done >> log-update.log 2>&1 &
(cd server; ./server.sh) >>log-server.log 2>&1 &
(sleep 10s; chromium-browser --kiosk --no-first-run --disable-infobars --disable-pinch --start-fullscreen --disk-cache-size=1 http://localhost:8080/?nocursor) 
read -t 30 -p "--"
