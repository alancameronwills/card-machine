Card donation system

The content of this directory is the code for the card donation machine in the church.

It's a continuous slideshow together with buttons people can press to trigger the card terminal device, 
which accepts their credit cards.

The client and server both run in the same machine, a Raspberry Pi running Debian Linux.
The client displays http://localhost:8080 
The server runs on Node.js.

The card terminal is provided by Square (https://squareup.com, https://developer.squareup.com).

The master copy of the code is kept in a cloud server. The donation machine periodically downloads
from the master, thereby allowing the content to be changed remotely.

Content of this directory:

* client/
	index.html - Main page displayed by the donation machine
 	img/ 	- Images for the slideshow, and various icons. If you put more in here, add them to manifest.txt
	js/	- JQuery
	code.html 	- Use this to obtain a new device code to login the card terminal.
* cred-*/	- [On back-end only] Credentials. Should only ever be kept on the server, not on github or on the front end
* server/
	server.js - Serves the client files and also provides the main interface to Square.
* get_local_files.py	- Used on the donation machine to periodically get a local copy of this directory, so that the machine can show the slideshow offline.
* manifest.txt	- List of files to be copied from backend to front-end by get_local_files.py.
* READ_ME.txt	- This file
¬ run-donations.sh			- Called when the window system starts. Opens the browser fullscreen on index.html
¬ run-get-local-files.sh	- Runs get_local_files.py and puts the results in a log file. Called 10 minutes after the donations machine starts up

¬ ~/.config/autostart/run-donations.desktop
	[Desktop Entry]
	Name=Fullscreen browser
	Exec=/home/pi/card-machine/run-donations.sh
	Type=Application

¬  = Not duplicated on master = not included in manifest.txt