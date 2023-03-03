const process = require('process');
const { timeStamp } = require('console');
const fs = require('fs/promises');
const util = require('util');

const { Readable } = require('stream');
const { finished } = require('stream/promises');
let previousMsg = "";


const source = "https://raw.githubusercontent.com/alancameronwills/card-machine/d732c7ea449d7fe32006eb59c57bfc79d2a41b0b";
const verbose = !!process.argv?.[2] ;
process.exitCode = 1;

async function go() {
	log ("v 1");
	let root = await fs.realpath('.');
	let manifestLocal = "", manifestRemote = "";
	try {
		manifestLocal = await fs.readFile(`${root}/manifest.txt`, "latin1");
	} finally {
	}
	try {
		manifestRemote = await fetch(`${source}/manifest.txt`).then(r => r.text());

	} catch (err) {
		log(`Can't get remote manifest ${source}/manifest.txt\n` + util.inspect(err));
		throw err;
	}
	if (manifestLocal.trim() == manifestRemote.trim()) {
		log("no change", verbose);
		setInterval(()=>process.exit(-1), 1000);
	}
	log(`Update from ${source} to ${root}`);
	let scan = async (manifest, action) => {
		for (let line of manifest.split(/\r?\n/)) {
			const name_timestamp = line.split(/[ \t#]+/, 2);
			log("Scan: " + line + util.inspect(name_timestamp), verbose);
			const [name, timeStamp] = name_timestamp.length > 1 ? [name_timestamp[1].trim(), name_timestamp[0].trim()] : [name_timestamp[0].trim(), ""];
			if (name) {
				await action(name, timeStamp);
			}
		}
	}

	let fileMap = {};
	await scan(manifestLocal, async (name, timeStamp) => {
		fileMap[name] = timeStamp;
	});
	let count = 0;
	let temp = `${root}/temp`;
	await scan(manifestRemote, async (name, timeStamp) => {
		if (!timeStamp || fileMap?.[name] != timeStamp) {
			let target = `${temp}/${name}`;
			try {
				await fs.mkdir(directory(target), { recursive: true });
				const { body } = await fetch(`${source}/${name}`);
				await fs.writeFile(target, body);
			} catch (err) {
				log(`Failed to copy ${name} ` + util.inspect(err));
			}

			log(name);
			count++;
		}
	});
	await fs.mkdir(temp, { recursive: true });
	await fs.writeFile(`${temp}/manifest.txt`, manifestRemote);
	log(`Copied ${count} to ${temp}`);
	process.exitCode = count == 0 ? -1 : 0;
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

go();
