/*
 * SMS relay for kiosks that reach the internet through a TP-Link / Archer 4G LTE router.
 *
 * Some routers receive SMS on their SIM (e.g. from the mobile operator, or people texting
 * the SIM number). Where the local config has an `smsRelay` field, we poll the router every
 * 90s, and forward any newly-arrived message on to a nominated phone number by asking the
 * router to send an SMS of its own.
 *
 * This runs completely independently of the donation kiosk: it is started in a try/catch by
 * server.js and, if anything goes wrong, it only affects the relay, never the kiosk.
 *
 * The router speaks TP-Link's "GDPR" encrypted CGI protocol: an RSA-512-signed, AES-128-CBC
 * encrypted command channel. The protocol here is a dependency-free port of
 * https://github.com/cmer81/tp-link-modem-sms-api (which itself builds on plewin's work).
 * That library needs axios + jsbn + express; this project ships no node_modules and runs
 * `node server.js` directly, so everything below uses only Node built-ins: `http`, `crypto`,
 * and native BigInt in place of jsbn's BigInteger.
 *
 * CLI test harness (run against a real router without the kiosk):
 *   node server/sms-relay.js <routerUrl> <login> <password> [<forwardTo>]
 *   - with no forwardTo: prints the current inbox
 *   - with forwardTo:    sends a single test SMS to that number
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const DC2 = String.fromCharCode(0x12); // the router encodes newlines within a field as this control char

const POLL_INTERVAL_MS = 90 * 1000;
const FIRST_POLL_DELAY_MS = 15 * 1000; // let networking settle after boot
const SEEN_LIMIT = 100;                // how many relayed-message keys we remember

/* ------------------------------------------------------------------ *
 * Crypto: RSA-512 (custom no-padding) using native BigInt, AES-128-CBC
 * ------------------------------------------------------------------ */

function modPow(base, exp, mod) {
	let result = 1n;
	base %= mod;
	while (exp > 0n) {
		if (exp & 1n) result = (result * base) % mod;
		exp >>= 1n;
		base = (base * base) % mod;
	}
	return result;
}

// Big-endian byte array -> BigInt (matches jsbn's `new BigInteger(byteArray)` for positive values;
// all data we sign is ASCII so the top bit is never set and the value is always positive).
function bytesToBigInt(bytes) {
	let x = 0n;
	for (const b of bytes) x = (x << 8n) | BigInt(b & 0xff);
	return x;
}

// Reproduces the reference implementation's `nopadding`: UTF-8 encode into an n-byte array,
// zero-filling the remainder. (The multi-byte ordering is unusual but our payloads are ASCII.)
function stringToPaddedBytes(s, n) {
	const bytes = [];
	let i = 0, j = 0;
	while (i < s.length && j < n) {
		const c = s.charCodeAt(i++);
		if (c < 128) {
			bytes[j++] = c;
		} else if (c < 2048) {
			bytes[j++] = (c & 63) | 128;
			bytes[j++] = (c >> 6) | 192;
		} else {
			bytes[j++] = (c & 63) | 128;
			bytes[j++] = ((c >> 6) & 63) | 128;
			bytes[j++] = (c >> 12) | 224;
		}
	}
	while (j < n) bytes[j++] = 0;
	return bytes;
}

// RSA public-key encrypt, chunked exactly as the router expects: 64-char plaintext blocks,
// each producing 128 hex chars. `n` and `e` are BigInts.
function rsaEncrypt(plainText, n, e) {
	const RSA_BIT = 512;
	const STR_EN_LEN = RSA_BIT / 4; // 128 hex chars out per chunk
	const step = RSA_BIT / 8;       // 64 plaintext bytes in per chunk
	const keyByteLen = (n.toString(2).length + 7) >> 3;
	let out = '';
	for (let start = 0; start < plainText.length; start += step) {
		const chunk = plainText.substring(start, start + step);
		const m = bytesToBigInt(stringToPaddedBytes(chunk, keyByteLen));
		let h = modPow(m, e, n).toString(16);
		if (h.length & 1) h = '0' + h;
		while (h.length < STR_EN_LEN) h = '0' + h;
		out += h;
	}
	return out;
}

class Encryption {
	constructor() {
		this.hash = undefined; // never set by the reference impl; signature carries the literal "h=undefined"
	}
	setParams(nnHex, eeHex, seq) {
		// nn and ee are both hex strings (ee looks decimal, e.g. "10001", but is 0x10001 = 65537).
		this.n = BigInt('0x' + nnHex);
		this.e = BigInt('0x' + eeHex);
		this.seq = parseInt(seq, 10);
		this.aesKey = crypto.randomBytes(8).toString('hex'); // 16 ASCII chars = 16 bytes = AES-128 key
		this.aesIv = crypto.randomBytes(8).toString('hex');
		this.aesKeyString = `key=${this.aesKey}&iv=${this.aesIv}`;
	}
	aesEncrypt(text) {
		const c = crypto.createCipheriv('aes-128-cbc', this.aesKey, this.aesIv);
		return c.update(text, 'utf8', 'base64') + c.final('base64');
	}
	aesDecrypt(b64) {
		const d = crypto.createDecipheriv('aes-128-cbc', this.aesKey, this.aesIv);
		return d.update(b64, 'base64', 'utf8') + d.final('utf8');
	}
	signature(seq, isLogin) {
		let s = isLogin ? this.aesKeyString + '&' : '';
		s += 'h=' + this.hash + '&s=' + seq;
		return rsaEncrypt(s, this.n, this.e);
	}
	// Encrypt a command/login payload, returning { data, sign }.
	encryptPayload(data, isLogin = false) {
		const encrypted = this.aesEncrypt(data);
		return { data: encrypted, sign: this.signature(this.seq + encrypted.length, isLogin) };
	}
}

/* ------------------------------------------------------------------ *
 * TP-Link data-frame protocol (ports RouterProtocol)
 * ------------------------------------------------------------------ */

const TP_ACT = { ACT_GET: 1, ACT_SET: 2, ACT_DEL: 4, ACT_GL: 5, ACT_GS: 6, ACT_CGI: 8 };

function attrsToKv(attrs) {
	if (!attrs) return '';
	if (typeof attrs === 'string') return attrs;
	if (Array.isArray(attrs)) return attrs.join('\r\n') + '\r\n';
	let ret = '';
	for (const key in attrs) {
		const v = attrs[key];
		if (v || v === 0 || v === '') {
			const value = typeof v === 'string' ? v.replace(/(\r\n|\n|\r)/gm, DC2) : v;
			ret += key + '=' + value + '\r\n';
		} else {
			ret += key + '\r\n';
		}
	}
	return ret;
}

function makeDataFrame(payload) {
	if (!Array.isArray(payload)) payload = [payload];
	const sections = payload.map(p => {
		const attrs = attrsToKv(p.attrs);
		return {
			method: p.method,
			controller: p.controller,
			stack: p.stack !== undefined ? p.stack : '0,0,0,0,0,0',
			pStack: '0,0,0,0,0,0',
			attrs,
			nbAttrs: attrs && attrs.match(/\r\n/g) != null ? attrs.match(/\r\n/g).length : 0
		};
	});
	let index = 0;
	const header = sections.map(s => s.method).join('&');
	const data = sections
		.map(s => `[${s.controller}#${s.stack}#${s.pStack}]${index++},${s.nbAttrs}\r\n${s.attrs}`)
		.join('');
	return header + '\r\n' + data;
}

function fromDataFrame(dataFrame) {
	const lines = dataFrame.trim().split(/\r?\n/); // tolerate \n or \r\n line endings
	let error = 0;
	const headerRe = /\[\d,\d,\d,\d,\d,\d\]\d/;
	const attrRe = /^([a-zA-Z0-9]+)=(.*)$/;
	const errorRe = /^\[error\](\d+)$/;
	let current = null;
	const data = [];
	for (const line of lines) {
		if (headerRe.test(line)) {
			if (current !== null) data.push(current);
			current = {};
			continue;
		}
		const errMatch = line.match(errorRe);
		if (errMatch) {
			error = parseInt(errMatch[1], 10);
			if (current !== null) { data.push(current); current = null; }
			continue;
		}
		const attrMatch = line.match(attrRe);
		if (attrMatch && current !== null) {
			current[attrMatch[1]] = attrMatch[2];
		}
	}
	if (current !== null) data.push(current);
	return { error, data };
}

/* ------------------------------------------------------------------ *
 * Minimal HTTP(S) client for the router. The router is on the LAN and may serve its
 * admin UI over http or (self-signed) https depending on the model/firmware.
 * ------------------------------------------------------------------ */

function httpRequest(method, urlString, body, headers) {
	return new Promise((resolve, reject) => {
		const u = new URL(urlString);
		const isHttps = u.protocol === 'https:';
		const transport = isHttps ? https : http;
		const payload = body != null ? Buffer.from(body, 'utf8') : null;
		const req = transport.request(
			{
				method,
				hostname: u.hostname,
				port: u.port || (isHttps ? 443 : 80),
				path: u.pathname + u.search,
				headers: {
					// Some firmware resets the connection on a POST that lacks a Content-Length.
					'Content-Length': payload ? payload.length : 0,
					...(headers || {})
				},
				timeout: 15000,
				rejectUnauthorized: false // routers use self-signed certs
			},
			res => {
				let chunks = '';
				res.setEncoding('utf8');
				res.on('data', d => (chunks += d));
				res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
			}
		);
		req.on('timeout', () => req.destroy(new Error('router request timed out')));
		req.on('error', err => reject(new Error(`${method} ${urlString}: ${err.message}`)));
		if (payload) req.write(payload);
		req.end();
	});
}

/* ------------------------------------------------------------------ *
 * Router client (ports RouterClient)
 * ------------------------------------------------------------------ */

class RouterClient {
	constructor(url, login, password, log) {
		this.url = url.replace(/\/+$/, '');
		this.login = login;
		this.password = password;
		this.log = log || (() => {});
		this.enc = new Encryption();
		this.sessionId = null;
		this.tokenId = null;
	}

	get isReady() {
		return this.sessionId != null && this.tokenId != null;
	}

	reset() {
		this.sessionId = null;
		this.tokenId = null;
	}

	async connect() {
		// 1. Fetch RSA public key + sequence.
		const parm = await httpRequest('POST', this.url + '/cgi/getParm', null, { Referer: this.url });
		const nn = parm.body.match(/nn="([0-9A-F]+)"/);
		const ee = parm.body.match(/ee="(\d+)"/);
		const seq = parm.body.match(/seq="(\d+)"/);
		if (!nn || !ee || !seq) throw new Error('getParm: could not parse encryption params');
		this.enc.setParams(nn[1], ee[1], seq[1]);

		// 2. Authenticate (login\npassword), AES-encrypted with the key RSA-signed into the request.
		const auth = this.enc.encryptPayload(this.login + '\n' + this.password, true);
		const loginUrl =
			this.url + '/cgi/login?data=' + encodeURIComponent(auth.data) +
			'&sign=' + auth.sign + '&Action=1&LoginStatus=0';
		const loginRes = await httpRequest('POST', loginUrl, null, { Referer: this.url });
		const setCookie = [].concat(loginRes.headers['set-cookie'] || []).join(';');
		const session = setCookie.match(/JSESSIONID=([a-f0-9]+)/);
		if (!session) throw new Error('login failed (no session cookie) - check router password');
		this.sessionId = session[1];

		// 3. Fetch the home page to obtain the per-session token.
		const home = await httpRequest('GET', this.url + '/', null, {
			Referer: this.url,
			Cookie: 'loginErrorShow=1; JSESSIONID=' + this.sessionId
		});
		const token = home.body.match(/var token="([a-f0-9]+)"/);
		if (!token) throw new Error('could not obtain session token');
		this.tokenId = token[1];
	}

	async execute(request, allowReconnect = true) {
		if (!this.isReady) await this.connect();
		const frame = makeDataFrame(request);
		const enc = this.enc.encryptPayload(frame);
		const payload = 'sign=' + enc.sign + '\r\ndata=' + enc.data + '\r\n';
		const res = await httpRequest('POST', this.url + '/cgi_gdpr', payload, {
			Referer: this.url,
			Cookie: 'loginErrorShow=1; JSESSIONID=' + this.sessionId,
			TokenID: this.tokenId,
			'Content-Type': 'text/plain'
		});
		if (res.status === 500 && allowReconnect) {
			// Session likely expired (or someone logged into the router UI). Reconnect once.
			this.reset();
			return this.execute(request, false);
		}
		if (res.status !== 200) throw new Error('router command HTTP ' + res.status);
		return fromDataFrame(this.enc.aesDecrypt(res.body));
	}

	// Returns the (up to 8) most recent received messages: {index, from, content, receivedTime, unread}.
	async readInbox() {
		const resetCursor = { method: TP_ACT.ACT_SET, controller: 'LTE_SMS_RECVMSGBOX', attrs: { PageNumber: 1 } };
		const list = {
			method: TP_ACT.ACT_GL,
			controller: 'LTE_SMS_RECVMSGENTRY',
			attrs: ['index', 'from', 'content', 'receivedTime', 'unread']
		};
		const res = await this.execute([resetCursor, list]);
		return res.data
			.filter(e => e.from !== undefined && e.content !== undefined)
			.map(e => ({
				index: e.index,
				from: e.from,
				content: (e.content || '').split(DC2).join('\n'),
				receivedTime: e.receivedTime,
				unread: parseInt(e.unread || '0', 10) > 0
			}));
	}

	async sendSms(to, content) {
		const res = await this.execute({
			method: TP_ACT.ACT_SET,
			controller: 'LTE_SMS_SENDNEWMSG',
			attrs: { index: 1, to, textContent: content }
		});
		if (res.error !== 0) throw new Error('send SMS failed, router error ' + res.error);
		return res;
	}
}

/* ------------------------------------------------------------------ *
 * Relay poller + de-duplication
 * ------------------------------------------------------------------ */

// Stable identity for a received message, independent of the volatile router `index`.
function messageKey(m) {
	return `${m.receivedTime}|${m.from}|${crypto.createHash('md5').update(m.content).digest('hex')}`;
}

async function loadSeen(fs, path) {
	try {
		const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
		if (Array.isArray(parsed.seen)) return { seen: new Set(parsed.seen), initialized: true };
	} catch { /* no file yet */ }
	return { seen: new Set(), initialized: false };
}

async function saveSeen(fs, path, seen) {
	const arr = Array.from(seen).slice(-SEEN_LIMIT);
	try {
		await fs.writeFile(path, JSON.stringify({ seen: arr }));
	} catch { /* best effort; a failed write just means we may re-relay after a restart */ }
}

function formatRelay(m) {
	// Keep the prefix short; long messages will be split/handled by the router.
	return `SMS to church SIM from ${m.from}: ${m.content}`;
}

/**
 * Start the SMS relay. Never throws; logs and keeps retrying on the poll interval.
 *
 * @param {object} config   The `smsRelay` object from the local card-machine.config
 *                          { to, password, url?, login? }
 * @param {function} log    server.js's log(msg) function
 * @param {string} root     repo root (for the persisted seen-keys file)
 */
function start(config, log, root) {
	log = log || ((m) => console.log(m));
	if (!config || !config.to || !config.password) {
		log('SMS relay: smsRelay config needs at least { to, password } - relay not started');
		return;
	}
	const fs = require('fs/promises');
	const url = config.url || 'http://192.168.1.1';
	const login = config.login || 'admin';
	const seenPath = `${root}/sms-relay-seen.json`;
	const client = new RouterClient(url, login, config.password, log);

	let state = null; // { seen, initialized }, loaded lazily on first poll

	async function poll() {
		try {
			if (!state) state = await loadSeen(fs, seenPath);
			const inbox = await client.readInbox();

			if (!state.initialized) {
				// First ever run: adopt the existing inbox as the baseline so we don't forward a
				// backlog of old messages. Only messages arriving from now on get relayed.
				for (const m of inbox) state.seen.add(messageKey(m));
				state.initialized = true;
				await saveSeen(fs, seenPath, state.seen);
				log(`SMS relay: baselined ${inbox.length} existing message(s); forwarding new ones to ${config.to}`);
				return;
			}

			// Oldest first, so the forward order matches arrival order.
			const fresh = inbox.filter(m => !state.seen.has(messageKey(m))).reverse();
			for (const m of fresh) {
				await client.sendSms(config.to, formatRelay(m));
				state.seen.add(messageKey(m));
				await saveSeen(fs, seenPath, state.seen);
				log(`SMS relay: forwarded message from ${m.from} to ${config.to}`);
			}
		} catch (err) {
			// Force a fresh login next time and try again on the next tick.
			client.reset();
			log('SMS relay poll error: ' + (err && err.message ? err.message : err));
		}
	}

	log(`SMS relay: enabled, polling ${url} every ${POLL_INTERVAL_MS / 1000}s, forwarding to ${config.to}`);
	setTimeout(function tick() {
		poll().finally(() => setTimeout(tick, POLL_INTERVAL_MS));
	}, FIRST_POLL_DELAY_MS);
}

module.exports = { start, RouterClient, rsaEncrypt, makeDataFrame, fromDataFrame, messageKey, loadSeen, saveSeen, SEEN_LIMIT };

/* ------------------------------------------------------------------ *
 * CLI test harness
 * ------------------------------------------------------------------ */

if (require.main === module) {
	(async () => {
		const [, , url, login, password, forwardTo] = process.argv;
		if (!url || !login || !password) {
			console.log('Usage: node server/sms-relay.js <routerUrl> <login> <password> [<forwardTo>]');
			process.exit(1);
		}
		const client = new RouterClient(url, login, password, console.log);
		try {
			if (forwardTo) {
				await client.sendSms(forwardTo, 'Test message from card-machine SMS relay');
				console.log('Test SMS sent to ' + forwardTo);
			} else {
				const inbox = await client.readInbox();
				console.log(`Inbox (${inbox.length} message(s)):`);
				for (const m of inbox) {
					console.log(`- [${m.unread ? 'unread' : 'read'}] ${m.receivedTime} from ${m.from}: ${m.content}`);
				}
			}
		} catch (err) {
			console.error('Error: ' + (err && err.message ? err.message : err));
			process.exit(2);
		}
	})();
}
