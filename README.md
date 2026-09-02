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
    * `deviceId` - of the Square card reader
    *  `auth` - from Square
    * `applicationId`
    * `signatureKey`
    * `appInsightsId` - same for each box
    * `appInsightsApiKey` - same for each box
    * `googleApiKey` - If present, extracts and displays info from calendar
    * `googleCalendar` - calendar id
    * `calendarWords` - Displays only items containing one of these terms
    * `code` - where to get nightly refresh of this code
    * `location` - id used to record distinct analytics
    * `churchName` - friendly name of location
    * `plea` - 
    * `offline` - html segment to show instead of money buttons
    * `strings` - `en` and `cy` versions of labelled strings
    * `smsRelay` - if present, polls the 4G LTE router (TP-Link / Archer) every 90s and
      forwards any newly-received SMS on to a nominated phone number, by asking the router
      to send an SMS. Relayed text is headed `Relayed via <churchName> from <sender's number>:`.
      A lone message keeps that header in the same SMS as the text (unless the two together
      exceed one SMS, when the header is sent first on its own). When several messages arrive
      together, consecutive ones from the same sender share a single header SMS ahead of them.
      Runs independently of the kiosk. It is an object:
        * `to` - destination phone number, e.g. `"+447700900123"` (required)
        * `password` - the router's admin password (required)
        * `url` - router address (optional, default `"http://192.168.1.1"`)
        * `login` - router admin username (optional, default `"admin"`)
      On first run the existing inbox is taken as a baseline (not forwarded); only messages
      arriving afterwards are relayed. Relayed-message keys are remembered in
      `sms-relay-seen.json` (repo root, gitignored) so a restart does not re-send them.
      Test against a real router with:
      `node server/sms-relay.js <url> <login> <password> [<forwardTo>]`

* ~/.config/autostart/run-donations.desktop - X-Windows config file starts card-machine/run.sh on power up :
[Desktop Entry]
Name=Fullscreen browser
Exec=/home/pi/card-machine/run.sh
Type=Application