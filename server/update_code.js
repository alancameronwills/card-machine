const process = require('process');
const { timeStamp } = require('console');
const fs = require('fs/promises');
const util = require('util');

const { Readable } = require('stream');
const { finished } = require('stream/promises');
let previousMsg = "";


const source = "https://raw.githubusercontent.com/alancameronwills/card-machine/master";
const verbose = !!process.argv?.[2] ;
process.exitCode = 1;

/**
 * Get the remote manifest and download any item that is new or has a changed version.
 * Manifest format: 
 * - manifest ::= {<item> \n}*
 * - item ::= <version> <space> <relative file path>
 * - version is a string without spaces, typically a date-timestamp
 * To make an item only be delivered to one client, include
 * "!<location>" somewhere in the file path 
 * e.g. client/img/slides!brynach/s01.jpg
 * where <location> is specified in cred*card-machine.config
 */

async function go() {
	let root = await fs.realpath('.');
	let credentials = await getCredentials(root);

	let manifestLocal = "", manifestRemote = "";
	try {
		manifestLocal = await fs.readFile(`${root}/manifest.txt`, "latin1");
	} finally {
	}
	try {
		let r = await fetchup(`${source}/manifest.txt`);
		if (r.status != "200") throw r.status;
		manifestRemote = await r.text();

	} catch (err) {
		log(`Can't get remote manifest ${source}/manifest.txt\n` + util.inspect(err));
		throw err;
	}
	if (manifestLocal.trim() == manifestRemote.trim()) {
		log("no change");
		setInterval(()=>process.exit(-1), 1000);
	}
	//log(`Update from ${source} to ${root}`);
	let scan = async (manifest, action) => {
		for (let line of manifest.split(/\r?\n/)) {
			const name_timestamp = line.split(/[ \t#]+/, 2);
			const [name, timeStamp] = name_timestamp.length > 1 ? [name_timestamp[1].trim(), name_timestamp[0].trim()] : [name_timestamp[0].trim(), ""];
			log(`Scan: timeStamp=${timeStamp} name=${name}` , verbose);
			if (name && (name.indexOf('!')<0 || name.indexOf('!'+(credentials.location||""))>=0)) {
				await action(name, timeStamp);
			}
		}
	}
	let temp = `${root}/temp`;
	await fs.mkdir(temp, { recursive: true });
	let fileMap = {};
	await scan(manifestLocal, async (name, timeStamp) => {
		fileMap[name] = timeStamp;
	});
	let count = 0;
	await scan(manifestRemote, async (name, timeStamp) => {
		if (!timeStamp || fileMap?.[name] != timeStamp) {
			let target = `${temp}/${name}`;
			try {
				log (`cp ${source}/${name} ${target}`, verbose);
				await fs.mkdir(directory(target), { recursive: true });
				const { body, status } = await fetchup(`${source}/${name}`);
				if (status != "200") throw status;
				await fs.writeFile(target, body);
				
			} catch (err) {
				log(`Failed to copy ${name} ` + util.inspect(err));
			}
			log(`  ${name}`);
			count++;
		}
	});
	await fs.writeFile(`${temp}/manifest.txt`, manifestRemote);
	if (count>0) log(`Copied ${count} to ${temp}`);
	process.exitCode = count == 0 ? -1 : 0;
}

async function fetchup (url) {
	let result = null, error = null;
	let success = false;
	for (let retry = 0; !success && retry < 3; retry++) {
		try {
			log ("fetchup " + url, verbose);
			result = await fetch(url);
			success = true;
		} catch (err) {
			error = err;
		}
	}
	if (result == null) throw error;
	return result;
}

function log(msg, condition = true) {
	if (condition && previousMsg != msg) {
		previousMsg = msg;
		console.log(`${new Date().toISOString()} ${msg}`);
	}
}
function directory(f) {
	return f.replace(/[^/]*$/, "");
}

function isBinary(fileName) {
	return [".jpg", ".jpeg", ".png", ".gif", ".pdf"].indexOf((fileName.toLowerCase().match(/(\.[^.]+)$/)?.[1])) >= 0;
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

go();
