/* Timings in seconds */

let slideChangeInterval = 15;
let successShowTime = 4;  // "Thank you" message
let transactionProgressPollInterval = 1; // Ping during transaction
let transactionTimeout = 300; // Cancel transaction if visitor walks away
let transactionComFailTimeout = 10; // How long to keep trying if ping fails during a transaction
let idlePingInterval = 120; // Check whether card terminal is alive at this interval
let recentActivityPingInterval = 20; // Check card terminal more often if recently failed or transaction
let pauseSlidePeriod = 60; // Pause if visitor clicks slide pause button
let leftSlidePause = 10;  // Extra pause if visitor clicks slide left button
let telemetryIdleMinutes = 60; // Report at least once every _ minutes
let calendarRefreshInterval = 3600; // Get Google calendar
let servicesShowPeriod = 60; // How long to show the Services page


/* ****************************************** */

let version = "" + Date.now();

let state = {
	ready: () => {
		// Showing money buttons, ready for action
		$("article").removeClass("pending");
		$("article").removeClass("waiting");
		$("article").removeClass("success");
	},
	waiting: (transaction) => {
		// User has touched a money button, waiting for ack from card machine
		$("article").removeClass("success");
		$("article").removeClass("pending");
		$("article").addClass("waiting");
		state.transaction = transaction;
	},
	pending: (transaction) => {
		// Card machine is waiting for user's card
		$("article").removeClass("success");
		$("article").removeClass("waiting");
		$("article").addClass("pending");
		state.transaction = transaction;
	},
	success: () => {
		// User has donated. Thanks!
		$("article").removeClass("pending");
		$("article").removeClass("waiting");
		$("article").addClass("success");
	},
	disconnected: () => {
		// Web down or card machine down, or card machine server down
		$("article").addClass("disconnected");
		$("article").removeClass("pending");
		$("article").removeClass("waiting");
		$("article").removeClass("success");
	},
	connected: () => {
		// Alias for ready
		$("article").removeClass("disconnected");
	},
	touch: () => {
		// No pointing device - usual. Additional to other states.
		$("article").addClass("touch");
	},
	isPending: () => $("article").hasClass("pending") || $("article").hasClass("waiting")
};

class CardTerminal {
	/**
	 * 
	 * @param {*} pingSeconds Seconds between pings
	 * @param {*} idlePingInterval Seconds between pings on successful ping
	 */
	constructor(pingSeconds = 10, idlePingInterval = 30) {
		this.pingInterval = pingSeconds;
		this.slowPingFactor = idlePingInterval / pingSeconds;
		this.pingCheck();
	}
	donate(amount) {
		let transaction = {
			idem: Date.now(),
			id: null,
			start: Date.now(),
			amount: amount
		};
		state.waiting();
		this.checkoutStatus(transaction);
		let timer = setInterval(() => {
			if (state.isPending()) {
				this.checkoutStatus(transaction);
			}
			else {
				clearInterval(timer);
			}
		}, transactionProgressPollInterval * 1000);
	}
	checkoutStatus(transaction) {
		fetch(`/card-operation.php?amount=${transaction.amount}&idem=${transaction.idem}&nocache=${Date.now()}`)
			.then(r => r.json())
			.then(ar => {
				if (ar.Response == "200") {
					let status = ar?.Content?.checkout?.status;
					console.log(`${status} ${transaction.idem}  ${ar?.Content?.checkout?.id}`);
					if (status) {
						jQuery("#status").html(status);
						if (status != "IN_PROGRESS" && status != "PENDING") {
							if (status == "COMPLETED") {
								// if this and the previous poll took longer than transactionProgressInterval to respond,
								// we might already have success - don't replicate analytics:
								if (state.isPending()) {
									this.success();
									transaction.status = status;
									analytics("transaction", transaction);
								}
							} else {
								this.cancel(null); // Cancelled from terminal
								transaction.status = ar?.data?.object?.checkout?.cancel_reason || status;
							}
						} else {
							if (transaction.id == null) {
								transaction.id = ar?.Content?.checkout?.id;
								state.pending(transaction);
							}
						}
					}
					if (Date.now() - transaction.start > transactionTimeout * 1000) this.cancel(transaction);
				} else {
					throw (ar.Response + " " + ar?.Content);
				}
			})
			.catch(e => {
				console.log("Status fetch: " + e.message);
				if (Date.now() - transaction.start > transactionComFailTimeout * 1000) this.cancel(transaction, "comfail");
				analytics("Status fetch: " + e.message, transaction)
			});
	}

	success() {
		state.success();
		setTimeout(() => this.cancel(null), successShowTime * 1000);
	}

	cancel(transaction = state.transaction, failed = false) {
		if (transaction) {
			fetch("/card-operation.php?action=cancel&idem=" + transaction.id)
				.catch(e => console.log("Cancel: " + e.message));
			analytics("Cancel " + Math.round((Date.now() - transaction.start) / 1000), transaction);
		}
		if (failed) {
			state.disconnected();
		}
		else {
			state.ready();
		}
	}

	pingCheck() {
		// Ping the device occasionally
		let pingid = Date.now();
		let pingIndicator = "";
		let pingCountDown = 0;
		setInterval(() => {
			if (!state.isPending()) {
				if (pingCountDown-- > 0) return;
				fetch(`/card-operation.php?action=ping&idem=${pingid}&nocache=${Date.now()}`)
					.then(r => r.json())
					.then(r => {
						let status = r?.Content?.action?.status || "--";
						switch (status) {
							case "COMPLETED":
								pingid = Date.now();
								pingIndicator = "";
								break;
							case "PENDING":
								pingIndicator += "_";
								break;
							default:
								// Transaction has timed out. Refresh idempotency, but keep counting 
								pingid = Date.now();
								pingIndicator += "-";
								break;
						}
						if (pingIndicator.length == 0) {
							state.connected();
							analytics("Connected");
							pingCountDown = this.slowPingFactor;
						} else if (pingIndicator.length > 3) {
							state.disconnected();
							analytics("Disconnected");
						}
					})
					.catch((e) => {
						console.log("Ping: " + e.message);
						pingIndicator += "#";
						if (pingIndicator.length > 2) {
							state.disconnected();
							analytics("Offline");
						}
						analytics("Ping " + e.message);
					})
					.finally(() => {
						jQuery("#pingstatus").html(pingIndicator.slice(-40));
					});
			} else {
				jQuery("#pingstatus").html("|");
			}
		}, this.pingInterval * 1000);
	}
}

class Slides {
	constructor() {
		this.numberOfSlides = 0;
		this.imgIndex = 0;
		this.imgCycle = 0;
		this.pauseTimer = null;
		this.go();
	}
	async go() {
		let slideSet = await this.getSlideSet();
		if (slideSet.info.length > 0) {
			$("#servicesImg")[0].src = `${slideSet.info[0]}?v=${version}`;
		}
		let figure = $("#bgImage");
		this.numberOfSlides = 0;
		for (let slideName of slideSet.show) {
			let img = document.createElement("img");
			img.src = `${slideName}?v=${version}`;
			img.id = `s${this.numberOfSlides}`;
			if (this.numberOfSlides != 0) img.style.opacity = 0;
			figure.append(img);
			this.numberOfSlides++;
		}
		this.cycleSlides();
	}
	cycleSlides() {
		$("#extraControls").removeClass("paused");
		clearInterval(this.imgCycle);
		this.imgCycle = setInterval(() => {
			this.nextSlide(1);
			buttons.showExtraButtons(1000);
		}, slideChangeInterval * 1000);
	}
	nextSlide(inc = 1) {
		document.getElementById(`s${this.imgIndex}`).style.opacity = 0;
		this.imgIndex = (this.imgIndex + inc + this.numberOfSlides) % this.numberOfSlides;
		document.getElementById(`s${this.imgIndex}`).style.opacity = 1;
	}

	pauseCycle(duration = 30000) {
		clearInterval(this.imgCycle);
		clearTimeout(this.pauseTimer);
		if ($("#extraControls").hasClass("paused")) {
			this.cycleSlides();
		} else {
			$("#extraControls").addClass("paused");
			this.pauseTimer = setTimeout(() => {
				this.cycleSlides();
			}, duration);
		}
	}

	async getSlideSet() {
		let showSlides = [];
		let infoSlides = [];
		await fetch("list-slides")
			.then(r => r.json())
			.then(r => {
				for (let item of r) {
					if (item.indexOf('-i-') >= 0)
						infoSlides.push(item);
					else
						showSlides.push(item);
				}
			})
			.catch(err => {
				showSlides = infoSlides = ["/img/noShowScreen.jpg"];
			});
		return { show: showSlides, info: infoSlides };
	}

}

class Buttons {
	constructor() {
		this.buttonTimer = null;
		this.setup();
	}
	showExtraButtons(period = 3000) {
		clearTimeout(this.buttonTimer);
		$("#extraControls").addClass("show");
		this.buttonTimer = setTimeout(() => {
			$("#extraControls").removeClass("show");
		}, period);
	}
	setup() {
		$("#bgImage").click(() => this.showExtraButtons());
		$("#donation-block").click(() => this.showExtraButtons());
		$("#extraControls").click(() => this.showExtraButtons());
		$("#left").click(() => { slides.nextSlide(-1); slides.pauseCycle(leftSlidePause * 1000); });
		$("#right").click(() => { slides.nextSlide(1); slides.pauseCycle(500); });
		$("#pause").click(() => { slides.pauseCycle(pauseSlidePeriod * 1000); })
		$("#left").contextmenu(event => { event.preventDefault(); slides.nextSlide(-1); slides.pauseCycle(leftSlidePause * 1000); });
		$("#right").contextmenu(event => { event.preventDefault(); slides.nextSlide(1); slides.pauseCycle(500); });
		$("#pause").contextmenu(event => { event.preventDefault(); slides.pauseCycle(pauseSlidePeriod * 1000); })

		$("#amountButtons").on("click", event => { event.stopPropagation(); });

		$("#services").click(() => services.hide());
		$("#servicesButton").click(() => services.show());
		$("#services").contextmenu(event => { event.preventDefault(); services.hide() });
		$("#servicesButton").contextmenu(event => { event.preventDefault(); services.show() });

		if (location.search.indexOf('nocursor') >= 0) { state.touch(); }
	}
}

class Services {
	constructor() {
		this.timer = null;
		this.hideDebounceTimer = null;
	}
	show() {
		$("#services").show(500);
		window.calendar.calendarLoad("servicesCalendar", 4);
		window.till.load("takings");
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.hide(), servicesShowPeriod * 1000);
		this.hideDebounceTimer = setTimeout(() => {
			clearTimeout(this.hideDebounceTimer);
			this.hideDebounceTimer = null;
		}, 1000);
		$("article")[0].requestFullscreen();
		analytics("Services");
	}
	hide() {
		if (!this.hideDebounceTimer) {
			clearTimeout(this.timer);
			$("#services").hide(500);
		}
	}
}

class Till {
	async load(location, rows = 7) {
		const truncDate = 10;
		let days = [];
		let amounts = [];
		{
			let dates = {};
			let lines = await fetch(`/get-donation-log?agg=${truncDate}&lines=${rows}`).then(r=>r.text());
			lines.split('\n').forEach(line => {
				let dateAmount = line.split('\t');
				if (dateAmount.length > 1) {
					dates[dateAmount[0]] = dateAmount[1];
				}
			});
			let ago = new Date();
			ago.setDate(ago.getDate() - rows);
			for (let i = 0; i < rows; i++) {
				ago.setDate(ago.getDate() + 1);
				amounts.push(dates[ago.toISOString().substring(0, truncDate)] || "0");
				days.push(['S', 'M', 'T', 'W', 'T', 'F', 'S'][ago.getDay()]);
			}
		}
		let html= `<div onclick="event.stopPropagation(); event.target.style.opacity=1;">
				<style>.tillList {opacity:0; display:flex;flex-direction:row;position:absolute;font-size:12pt;color:white;} 
				.tillList>div {user-select:none;display:flex;flex-direction:column;align-items:center;margin:0 10px;}</style>
				<div class='tillList'>${days.reduce((p,c,i,a)=>p+`<div><div>${c}</div><div>${amounts[i]}</div></div>`, "")}</div>
			</div>`;
		document.getElementById(location).innerHTML = html;
	}
}

class Calendar {
	constructor() {
		this.stopped = false;
		this.timer = nowAndEvery(calendarRefreshInterval * 1000, () => this.calendarLoad("calendarExtract", 2));
	}

	calendarLoad(location, rows = 4) {
		if (this.stopped) return;
		let serviceWords = ["communion", "prayer", "service", "vigil", "mass"];
		fetch('/calendar')
			.then(r => {
				if (r.status == 444) {
					throw "stopCalendar";
				}
				return r.json();
			})
			.then(r => {
				let table = ["<table class='calendar'><tr><td>"];
				let rowCount = 0;
				r.items.forEach(item => {
					let when = new Date(item.start.dateTime);
					let summaryLC = item.summary.toLowerCase();
					if (serviceWords.some(s => summaryLC.indexOf(s) >= 0)) {
						let whenDate = new Date(when);
						if (rowCount++ < rows) {
							table.push(`${item.summary} </td><td> ${whenDate.getHours()}:${whenDate.getMinutes()} ${whenDate.toDateString()}</td></tr><tr><td>`);
						}
					}
				});
				table.push("</td></tr></table>");
				document.getElementById(location).innerHTML = table.join("");
			})
			.catch(e => {
				if (e == "stopCalendar") {
					this.stopped = true;
					clearInterval(this.timer);
				}
			});
	}

}

class RomanClock {
	constructor() {
		setInterval(() => {
			let time = new Date();
			let hh = time.getHours();
			let mm = time.getMinutes();
			let ss = time.getSeconds();
			$("#hhmm").html(`${this.digitToRoman(hh)} : ${this.digitToRoman(mm)}`);
			$("#ss").html("&nbsp;: " + this.digitToRoman(ss));
		}, 1000);
	}
	digitToRoman(n) {
		let r = "";
		let i = n;
		let eq = (v, s) => { if (i == v) { r += s; i = 0; } };
		let ge = (v, s) => { if (i >= v) { r += s; i -= v; return true; } else return false; };
		ge(50, "L");
		ge(40, "XL");
		while (ge(10, "X")) { }
		eq(9, "IX");
		ge(5, "V");
		eq(4, "IV");
		while (ge(1, "I")) { }
		return r;
	}
}

var previousAnalyticsMessage = "";
var lastTelemetry = 0;
function analytics(message, transaction) {
	let locatedMessage = (window?.configs?.location || "") + " " + message;
	let logMessage = locatedMessage;
	if (transaction) {
		transaction.age = (Date.now() - transaction.start) / 1000;
		logMessage += " " + JSON.stringify(transaction);
	}
	if (logMessage != previousAnalyticsMessage || (Date.now() - lastTelemetry) / 60000 > telemetryIdleMinutes) {
		console.log(new Date().toISOString() + " " + logMessage);
		previousAnalyticsMessage = logMessage;
		lastTelemetry = Date.now();
		let properties = { location: window?.configs?.location };
		if (transaction) properties.transaction = transaction;
		appInsights.trackEvent({ name: locatedMessage, properties: properties });
	}
}

function nowAndEvery(interval, fn) {
	fn();
	return setInterval(fn, interval);
}

function waitNotNull(property, interval = 200, timeout = 2000) {
	return new Promise((resolve, reject) => {
		const countOut = timeout / interval;
		let count = 0;
		let pollTimer = setInterval(
			() => {
				if (property()) {
					clearInterval(pollTimer);
					resolve(property());
				} else {
					if (count++ > countOut) {
						clearInterval(pollTimer);
						reject("timeout");
					}
				}
			}
			, interval)
	})
}

async function SetPageHoles() {
	let configs = await fetch("config").then(r => r.json());
	if (configs.churchName) $("#pleaseSupport").text(`Please support ${configs.churchName}`);
	if (configs.plea) $("#plea").html(`<span>${configs.plea}</span>`);
	if (configs.offline) $("#offline").html(configs.offline);
	if (configs.buttonPosition) $("#extraControls").css(configs.buttonPosition);
	return configs;
}

$(async () => {
	window.buttons = new Buttons();
	window.slides = new Slides();
	window.services = new Services();
	window.cardTerminal = new CardTerminal(recentActivityPingInterval, idlePingInterval);
	window.calendar = new Calendar();
	window.till = new Till();
	window.romanClock = new RomanClock();
	window.configs = await SetPageHoles();
	analytics("Startup " + location.origin);
})
