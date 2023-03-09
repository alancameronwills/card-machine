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
	 * @param {*} successPingSlowFactor Wait this multiple on successful ping
	 */
	constructor(pingSeconds = 10, successPingSlowFactor = 3) {
		this.pingInterval = pingSeconds;
		this.slowPingFactor = successPingSlowFactor;
		this.pingCheck();
	}
	donate(amount) {
		state.waiting();
		const idem = Date.now();
		fetch(`/card-operation.php?amount=${amount}&idem=${idem}`)
			.then(r => r.json())
			.then(r => {
				if (r.Response == "200") {
					console.log("donate");
					let transaction = {
						idem: idem,
						id: r.Content.checkout.id,
						start: Date.now(),
						amount: amount
					};
					state.pending(transaction);
					let timer = setInterval(() => {
						if (state.isPending()) {
							this.checkoutStatus(transaction);
						}
						else {
							clearInterval(timer);
						}
					}, 1000);
				}
			})
			.catch(e => console.log("Donate fetch: " + e.message));
	}
	checkoutStatus(transaction) {
		fetch(`/card-operation.php?amount=${transaction.amount}&idem=${transaction.idem}&nocache=${Date.now()}`)
			.then(r => r.json())
			.then(ar => {
				if (ar.Response == "200") {
					let status = ar?.Content?.checkout?.status;
					console.log(`${status} ${transaction.idem}  ${ar.Content.checkout.id}`);
					if (status) {
						jQuery("#status").html(status);
						if (status != "IN_PROGRESS" && status != "PENDING") {
							if (status == "COMPLETED") {
								this.success();
								transaction.status = status;
							} else {
								this.cancel(null);
								transaction.status = ar?.data?.object?.checkout?.cancel_reason || status;
							}
							analytics("transaction", transaction);
						}
					}
					if (Date.now() - transaction.start > 300000) this.cancel(transaction);
				}
			})
			.catch(e => {
				console.log("Status fetch: " + e.message);
				if (Date.now() - transaction.start > 10000) this.cancel(transaction);
				analytics("Status fetch: " + e.message, transaction)
			});
	}

	success() {
		state.success();
		setTimeout(() => this.cancel(null), 4000);
	}

	cancel(transaction = state.transaction) {
		if (transaction) {
			fetch("/card-operation.php?action=cancel&idem=" + transaction.id)
				.catch(e => console.log("Cancel: " + e.message));
			analytics("Cancel", transaction);
		}
		state.ready();
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
								state.connected();
								analytics("Connected");
								pingCountDown = this.slowPingFactor;
								break;
							case "PENDING":
								pingIndicator += "_";
								if (pingIndicator.length > 2) {
									state.disconnected();
									analytics("Disconnected");
								}
								break;
							default:
								// Transaction has timed out. Refresh idempotency, but keep counting 
								pingid = Date.now();
								pingIndicator += "-";
								break;
						}
					})
					.catch((e) => {
						console.log("Ping: " + e.message);
						pingIndicator += "#";
						if (pingIndicator.length > 2) {
							state.disconnected();
							analytics("Offline");
						}
						analytics("Ping", e.message);
					})
					.finally(() => {
						jQuery("#pingstatus").html(pingIndicator);
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
		}, 30000);
	}
	nextSlide(inc = 1) {
		document.getElementById(`s${this.imgIndex}`).style.opacity = 0;
		this.imgIndex = (this.imgIndex + inc + this.numberOfSlides) % this.numberOfSlides;
		document.getElementById(`s${this.imgIndex}`).style.opacity = 1;
	}

	pauseCycle(duration = 60000) {
		clearInterval(this.imgCycle);
		clearTimeout(this.pauseTimer);
		$("#extraControls").addClass("paused");
		this.pauseTimer = setTimeout(() => {
			this.cycleSlides();
		}, duration);
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
	showExtraButtons() {
		clearTimeout(this.buttonTimer);
		document.getElementById("extraControls").style.opacity = 1;
		this.buttonTimer = setTimeout(() => {
			document.getElementById("extraControls").style.opacity = 0;
		}, 10000);
	}
	setup() {
		$("#bgImage").click(() => this.showExtraButtons());
		$("#donation-block").click(() => this.showExtraButtons());
		$("#extraControls").click(() => this.showExtraButtons());
		$("#left").click(() => { slides.nextSlide(-1); slides.pauseCycle(1000); });
		$("#right").click(() => { slides.nextSlide(1); slides.pauseCycle(1000); });
		$("#pause").click(() => { slides.pauseCycle(60000); })

		$("#amountButtons").on("click", event => { event.stopPropagation(); });

		$("#services").click(() => services.hide());
		$("#servicesButton").click(() => services.show());

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
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.hide(), 60000);
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

class Credentials {
	constructor() {
		this.cred = null;
		this.fetchCredentials();
	}
	async fetchCredentials() {
		this.cred = await fetch("credentials").then(r => r.json());
	}
	async get() {
		await waitNotNull(()=>this.cred);
		return this.cred;
	}
}

class Calendar {
	constructor() {
			//nowAndEvery(6 * 60 * 1000, () => this.calendarLoad("calendarExtract", 2));
			this.calendarLoad("calendarExtract", 2)
	}

	calendarLoad(location, rows = 4) {
		let serviceWords = ["communion", "prayer", "service", "vigil", "mass"];
		fetch('/calendar')
			.then(r => r.json())
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
function analytics(message, transaction) {
	let s = message;
	if (transaction) {
		transaction.age = (Date.now() - transaction.start) / 1000;
		s += " " + JSON.stringify(transaction);
	}
	if (s != previousAnalyticsMessage) {
		console.log(new Date().toISOString() + " " + s);
		previousAnalyticsMessage = s;
		appInsights.trackEvent({ name: message, properties: (transaction ? { p1: transaction } : null) });
	}
}

function nowAndEvery(interval, fn) {
	fn();
	return setInterval(fn, interval);
}

function waitNotNull(property, interval=200, timeout=2000) {
	return new Promise ((resolve, reject) =>{
		const countOut = timeout/interval;
		let count = 0;
		let pollTimer = setInterval(
			() => {if (property()) {
				clearInterval(pollTimer);
				resolve(property());
			} else {
				if (count++ > countOut) {
					clearInterval(pollTimer);
					reject("timeout");
				}
			}}
		, interval)
	})
}


$(async () => {
	window.buttons = new Buttons();
	window.slides = new Slides();
	window.services = new Services();
	window.cardTerminal = new CardTerminal(10, 3);
	window.credentials = new Credentials();
	window.calendar = new Calendar();
	window.romanClock = new RomanClock();
	$("#pleaseSupport").text(`Please support ${(await window.credentials.get()).churchName}`);
	analytics("Startup", location.origin);
})
