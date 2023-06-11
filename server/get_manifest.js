
const fs = require('fs/promises');
const util = require('util');

const apiRoot = "https://api.github.com/repos/alancameronwills/card-machine/";

async function getPathList() {
	let response = await fetch(apiRoot+"git/trees/master?recursive=1");
	if (response.status == 200){
		let data = await response.json();
		let fileList =
			data.tree.filter(item => item.type == "blob" && item.path.indexOf(".") != 0)
				.map(item => item.path);
		return fileList;
	} else {
		console.log(`getPathList: ${response.status} ${response.statusText}`);
		return [];
	}
}

async function getCommitDate(path) {
	let url = `${apiRoot}commits?path=${path}`;
	console.log(url);
	let history = await fetch(url)
		.then(r=>r.json());
	
	try {
		return history[0].commit.committer.date;
	} catch(e) {
		console.log(e);
		console.log(util.inspect(history));
		return "-";
	}
}

async function constructManifest() {
	let pathList = await getPathList();
	let manifest = [];
	for (let i = 0; i< pathList.length; i++) {
		manifest.push(`${await getCommitDate(pathList[i])} ${pathList[i]}`);
	}
	return manifest;
}

async function writeManifest() {
	let manifest = await constructManifest();

	await fs.writeFile(`temp/manifest.txt`, manifest.join("\n"));
}

writeManifest();


