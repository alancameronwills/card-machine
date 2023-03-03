#!/bin/bash
cd `dirname $BASH_SOURCE`
# (sleep 10m; date; python get_local_files.py; date) >log-get-local-files.txt 2>&1 &
./server.sh >>log-server.log 2>&1 &
(sleep 10s; chromium-browser --kiosk --no-first-run --disable-infobars --disable-pinch --start-fullscreen --disk-cache-size=1 http://localhost:8080/?nocursor)
read -t 30 -p "--"
