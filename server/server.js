const http = require('http');
const util = require('util');
const fs = require('fs/promises');

const logverbose = false;


const contentTypes = {
	".css": "text/css",
	".htm": "text/html", ".html": "text/html",
	".gif": "image/gif",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".js": "text/js",
	".json": "application/json",
	".mp3": "audio/mpeg", ".mp4": "video/mp4", ".mpeg": "video/mpeg",
	".png": "image/png",
	".pdf": "application/pdf",
	".txt": "text/plain"
};

(async () => {
	let root = await fs.realpath('.');
	root = root.replace("/server", "");
	const clientRoot = `${root}/client`;
	log("Client root: " + clientRoot);
	const credentials = await getCredentials(root);

	const handlers = {
		"get-url": getUrl,
		"card-operation": cardOperation,
		"list-slides": listSlides,
		"ping": async () => { return { body: 'pong', status: 200, contentType: "text/plain" } },
		"calendar": calendar,
		"credentials" : async () =>{return {body: `{"churchName":"${credentials.churchName}"}`, status:200, contentType:"application/json"}}
	};

	function serve(request, response) {
		try {
			let req = parseReq(request);
			let contentType = contentTypes[req.extension] ?? "";
			req.path = req.path.replace("\/card-machine\/", "/");
			req.contentType = contentType;

			if (!contentType) {
				let recognized = false;
				for (let k of Object.keys(handlers)) {
					if (req.path.indexOf("/" + k) == 0) {
						(async () => {
							try {
								let reply = await handlers[k](req.params, credentials, clientRoot);
								response.writeHead(reply.status, { "Content-Type": reply.contentType });
								response.end(reply.body);
							} catch (err) {
								log("Handler exception: " + util.inspect(err));
							}
						})()
						recognized = true;
					}
				}
				if (!recognized) {
					response.writeHead("404", "text/plain");
					response.end("Not found: " + req.path);
				}
			} else {
				let reply = util.inspect(req);
				let replyType = "application/json";
				if (req.path.indexOf("..") < 0) {
					if (req.path.indexOf(".html") > 0) log("File: " + req.path);
					(async () => {
						try {
							reply = await fs.readFile(clientRoot + req.path);
							replyType = contentType;
						} catch (err) {
							req.err = err;
							reply = util.inspect(req);
						} finally {
							response.writeHead(200, { "Content-Type": replyType });
							response.end(reply);
						}
					})()
				}
			}
		} catch (err) {
			log("Serve exception " + util.inspect(err));
		}
	}

	const server = http.createServer(serve);
	const port = process.argv[2] || 80;
	server.listen(port);
	log(`Server running at http://localhost:${port}`);
})()

async function cardOperation(params, credentials) {
	let suffix = "", task = {};
	switch (params.action) {
		case "cancel":
			suffix = `terminals/checkouts/${params.idem}/cancel`;
			break;
		case "ping":
			suffix = `terminals/actions`;
			task = {
				action: {
					device_metadata: {},
					save_card_options: {},
					type: "PING",
					device_id: credentials.deviceId
				}
			};
			break;
		case "login":
			suffix = "devices/codes";
			task = { device_code: { product_type: "TERMINAL_API", name: "Card reader" } };
			break;
		default:
			suffix = "terminals/checkouts";
			task = {
				checkout: {
					amount_money: { amount: 1 * params.amount, currency: "GBP" },
					device_options: {
						collect_signature: false,
						skip_receipt_screen: true,
						tip_settings: {
							allow_tipping: false,
							custom_tip_field: false,
							separate_tip_screen: false,
							smart_tipping: false
						},
						device_id: credentials.deviceId
					},
					payment_options: {},
					payment_type: "CARD_PRESENT",
					deadline_duration: "PT2M",
					reference_id: "donation"
				}
			}
	}
	let url = "https://connect.squareup.com/v2/" + suffix;
	let headers = {
		"Square-Version": "2022-10-19",
		"Authorization": credentials.auth,
		"Content-Type": "application/json"
	};
	let http = {
		max_redirects: 0,
		request_fullurl: 1,
		ignore_errors: true,
		method: "post",
		headers: headers
	}

	if (params.action != "cancel") {
		task["idempotency_key"] = params.idem;
		http.body = JSON.stringify(task);
	}

	try {
		verbose("Card operation: " + url);
		verbose(util.inspect(http));
		log(params.action || params.amount);
		let reply = await fetch(url, http);
		let contentType = reply.headers.get("content-type");
		if (contentType.indexOf("json") > 0) {
			let jsonData = await reply.json();
			verbose("Reply Data: " + JSON.stringify(jsonData));
			return {
				body: JSON.stringify(
					{ Content: jsonData, Response: reply.status }
				), status: reply.status, contentType: contentType
			};
		} else {
			log(`Card operation: ${url} \n ${util.inspect(http)}\nReply Content-Type: ${contentType}`);
			let textData = await reply.text();
			log("Text: " + textData);
			return { body: textData, status: reply.status, contentType: "text/plain" };
		}
	} catch (err) {
		let errReport = util.inspect(err);
		if (errReport.indexOf("fetch failed") >= 0) errReport = errReport.match(/cause:.*$/)[0] || errReport;
		log("   " + errReport);
		verbose(`Card operation: ${url} \n ${util.inspect(http)}\nError: ${util.inspect(err)}`);
		return { body: util.inspect(err), status: 400, contentType: "application/json" };
	}
}

async function listSlides(params, credentials, clientRoot) {
	let imgdir = await fs.readdir(`${clientRoot}/img`, { withFileTypes: true });
	let slidesDir = "";
	for (let item of imgdir) {
		if (item.isDirectory && item.name.startsWith("slides")
			&& (item.name.indexOf("!") < 0 || !credentials?.location
				|| item.name.indexOf(credentials.location >= 0))) {
			slidesDir = item.name;
			break;
		}
	}
	let dir = await fs.readdir(`${clientRoot}/img/${slidesDir}`);
	let urlDir = dir.map(d => `/img/${slidesDir}/${d}`);
	return { body: JSON.stringify(urlDir), contentType: "application/json", status: 200 };
}


// Put the credentials in a directory with a random name beginning 'cred-'
// Directories can't be read by http.
// Must be valid JSON
async function getCredentials(root) {
	let config = {};
	let dir = await fs.readdir(root);
	for (let item of dir) {
		if (item.startsWith("cred-")) {
			config = JSON.parse(await fs.readFile(`${root}/${item}/card-machine.config`));
		}
	}
	return config;
}

async function getUrl(params) {
	let url = "https://" + params["u"];
	log("Get url: " + url);
	try {
		let response = await fetch(url);
		replyType = response.headers.get("content-type");
		verbose(response.status);
		verbose(util.inspect(response.headers));
		verbose("Content-Type: " + replyType);
		let reply = await response.text();
		return {
			status: response.status,
			contentType: response.headers.get("content-type"),
			body: reply
		}
	} catch (err) {
		log("Error: " + JSON.stringify(err));
		return { status: 500, contentType: "text/plain", body: JSON.stringify(err) };
	}
}

async function calendar(params, credentials) {
	if (!credentials.googleCalendar) return{status:400,contentType:"text/plain", body:"no calendar credentials"};
	let today = new Date();
	let todayMonth = new Date();
	todayMonth.setMonth(todayMonth.getMonth() + 1);
	let url = `www.googleapis.com/calendar/v3/calendars/${credentials.googleCalendar}`
		+ `/events?timeMin=${today.toISOString()}&timeMax=${todayMonth.toISOString()}`
		+ `&singleEvents=true&orderBy=startTime&key=${credentials.googleApiKey}`;
	return await getUrl({u:url});
}

function parseReq(request, defaultPage = "/index.html") {
	let url = request.url;
	let method = request.method;
	let headers = {};
	for (let i = 0; i < request.rawHeaders.length; i += 2) {
		headers[request.rawHeaders[i]] = request.rawHeaders[i + 1];
	}
	let host = headers.Host;
	let path = url.replace(/[\?#].*/, "");
	if (path == "/") path = defaultPage;
	let extension = path.match(/\.[^.]*$/)?.[0] ?? "";
	let query = url.match(/\?(.*)/)?.[1] ?? "";  // url.replace(/.*\?/,"");
	let paramStrings = query.split('&');
	let params = paramStrings.reduce((m, keqv) => {
		if (!keqv) return m;
		let kv = keqv.split('=');
		m[kv[0]] = kv.length > 1 ? kv[1] : true;
		return m;
	}, {});
	return { path: path, extension: extension, query: query, params: params, host: host, url: url, method: method, headers: headers };
}

function verbose(msg) {
	if (logverbose) log(msg);
}
let previousMsg = "";
function log(msg, condition = true) {
	if (condition && previousMsg != msg) {
		previousMsg = msg;
		console.log(`${new Date().toISOString()} ${msg}`);
	}
}


