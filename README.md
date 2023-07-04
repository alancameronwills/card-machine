# Card donation system

The content of this directory is the code for the card donation machine in the church.

It displays a continuous slideshow together with buttons people can tap to trigger the card terminal device, which accepts their credit cards.

The user interface is a web page running on Chrome. 

The client and server both run in the same machine, a Raspberry Pi running Debian Linux.
The client displays http://localhost:8080 
The server runs on Node.js.

The card terminal is provided by Square (https://squareup.com, https://developer.squareup.com).

The client web page sends REST requests to the server, running on the same machine.
The server relays requests to the card terminal API at squareup.com. 
There is no local connection between the Raspberry Pi and the card terminal. 
Requests and status enquiries are sent to the Squareup.com server, which pushes them 
to the card terminal. Our software running on the Pi polls Squareup.com for the status
of the card terminal.

The master copy of the code is kept in GitHub at https://github.com/alancameronwills/card-machine  

Content of this directory:

* client/
  *	code.html 	- Use this to obtain a new device code to login the card terminal.
  * index.html - Main page displayed by the donation machine
  * img/ 	- Images for the slideshow, and various icons.
		slides!<systemID>/* - slides for displaying on a particular machine
			"!" in the name ==> update-code only gets the items for local systemID
  * css/*
  * js/*
* server/
  *	server.js - Serves the client files and also provides the interface to Square.
  * server.sh - Checks server.js is running; if not, calls restart-server.sh
  * restart-server.sh - what it says
* fetch-code.sh	- Gets latest code from GitHub
* run.sh		- Called when the window system starts. Opens the browser fullscreen on index.html
* READ_ME.md	- This file

* cred-*/card-machine.config	- [On machine only - no copy in git] 
  Credentials specific to the machine. 
		Includes the ID of the card terminal, account credentials for SquareUp.
		No copy of this file on GitHub.

* ~/.config/autostart/run-donations.desktop - X-Windows config file starts card-machine/run.sh on power up
