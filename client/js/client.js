/* Timings in seconds */

let slideChangeInterval = 15;
let successShowTime = 4;  // "Thank you" message
let transactionProgressPollInterval = 1; // Ping during transaction
let transactionTimeout = 300; // Cancel transaction if visitor walks away
let transactionComFailTimeout = 10; // How long to keep trying if ping fails during a transaction
let idlePingInterval = 120; // Check whether card terminal is alive at this interval
let recentActivityPingInterval = 20; // Check card terminal more often if recently failed or transaction
let nightPingInterval = 1200; // Slower pings overnight
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
	constructor() {
		this.pingInterval = recentActivityPingInterval;
		this.slowPingFactor = idlePingInterval / recentActivityPingInterval;
		this.nightPingFactor = nightPingInterval / recentActivityPingInterval;
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
									fetch('/log-donation?amount=' + transaction.amount);
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
		let pingSuccessCounter = 0;
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
								// Check for App Insights connection problem:
								if(pingSuccessCounter++ == 3 && new Date().getHours()<9) {
									// Connection now well established and it's early enough for messing about.
									if (Array.isArray(appInsights["queue"]) && appInsights["queue"].length == 0) {
										// appInsights failed to load because of initial connection problem
										window.location.reload();
									}
								}
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
							pingCountDown = this.isDaytime() ? this.slowPingFactor : this.nightPingFactor;
						} else if (pingIndicator.length > 3) {
							state.disconnected();
							analytics("Disconnected");
							if (!this.isDaytime()) pingCountDown = this.nightPingFactor;
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
	isDaytime() {
		let h = new Date().getHours();
		return h > 7 && h < 22;
	}
}

class CategoryList {
	constructor() {
		this.items = {en:[],cy:[]};
		this.currentIndex = 0;
		this.currentCategory = "en";
	}
	nextIndex(category="en") {
		if (!Array.isArray(this.items[category])) this.items[category] = [];
		return this.items[category].length;
	}
	add(item, category="en") {
		if (!Array.isArray(this.items[category])) this.items[category] = [];
		this.items[category].push(item);
	}
	current() {
		return this.items[this.currentCategory][this.currentIndex];
	}
	next (inc, zeroPassing) {
		let length = this.items[this.currentCategory].length;
		this.currentIndex = (this.currentIndex + inc + length) % length;
		if (this.currentIndex==0 && zeroPassing) zeroPassing();
		return this.current();
	}
	changeLanguage(category) {
		if (this.items[category] && this.items[category].length>0){
			this.currentCategory = category;
			// Should be the same number of items in each category, but just in case:
			this.currentIndex = this.currentIndex % this.items[category].length;
		}
	}
}

class Slides {
	constructor() {
		languageSwitch.observer(this);
		this.slides = new CategoryList();
		this.info = new CategoryList();
		this.language = "en"; // Saesneg
		this.notEnglishCycles = 0;
		this.imgIndex = 0;
		this.imgCycle = 0;
		this.pauseTimer = null;
		this.go();
	}
	change(slideSet, fnChange) {
		let oldItem = slideSet.current();
		fnChange(slideSet);
		oldItem.style.opacity = 0;
		slideSet.current().style.opacity = 1;
	}
	changeLanguage(language) {
		let lc = s => s.changeLanguage(language);
		this.change(this.slides, lc);
		this.change(this.info, lc);
	}
	nextSlide(inc, screenSet="slides") {
		this.change(this[screenSet], s => s.next(inc,
			 inc==1 && (()=>languageSwitch.countDownToRevert())));
	}
	async go() {
		let imgSrcList = await this.getImgSrcList();

		// HTML display locations of the sets:
		this.slides.div = $("#bgImage");
		this.info.div = $("#servicesImage");

		// Sort screens by set (info or slides) and language 
		for (let imgSrc of imgSrcList) {
			let img = document.createElement("img");
			img.src = `${imgSrc}?v=${version}`;
			let slideSet = img.src.indexOf("-i-")>0 ? this.info : this.slides;
			let slideLanguage = img.src.match(/cy[0-9-]/) ? "cy" : "en";
			let index = slideSet.nextIndex(slideLanguage);
			img.id = `${slideLanguage}${index}`;
			img.style.opacity = 0;
			slideSet.add(img, slideLanguage);	
			slideSet.div.append(img);
		}
		// Set first slide visible:
		this.change(this.slides, ()=>{});
		this.change(this.info, ()=>{});

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

	async getImgSrcList() {
		return await fetch("list-slides")
			.then(r => r.json())
			.catch(err => {
				return ["/img/noShowScreen.jpg"];
			});
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
		if (configs["buttonPosition"]) $("#extraControls").css(configs.buttonPosition);
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
		window.receipts.load("takings");
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

class LanguageSwitch {
	constructor(languages = ["en","cy"]) {
		this.languages = languages;
		this.language = languages[0];
		this.observers = [];
		this.nonEnglishCountDown = 0;
	}
	observer(o) {
		this.observers.push(o);
	}
	switchTo(language) {
		if (language != this.language) {
			this.language = language;
			this.observers.forEach(o => o.changeLanguage(language));
			if (language != "en") {
				this.nonEnglishCountDown = 2;
			}
		}
	}
	flip() {
		let newIndex = (this.languages.findIndex(s=>s==this.language) + 1) % this.languages.length ;
		this.switchTo(this.languages[newIndex]);
	}
	countDownToRevert() {
		if (this.nonEnglishCountDown>0) {
			this.nonEnglishCountDown--;
			if (this.nonEnglishCountDown==0) {
				this.switchTo("en");
			}
		}
	}
}

class Receipts {
	async load(location, rows = 7) {
		$(`#${location}`).html("");
		const truncDate = 10;
		let days = [];
		let amounts = [];
		{
			let dates = {};
			let lines = await fetch(`/get-donation-log?agg=${truncDate}&lines=${rows}`).then(r => r.text());
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
		$(`#${location}`).html(
			`<div onclick="event.stopPropagation(); event.target.style.opacity=1;">
				<style>
					.receipts {opacity:0; display:flex;flex-direction:row;position:absolute;font-size:12pt;color:white;} 
					.receipts>div {display:flex;flex-direction:column;align-items:center;margin:0 10px;}
					.receipts div {user-select:none;pointer-events:none;} 
				</style>
				<div class='receipts'>${days.reduce((p, c, i, a) => p + `<div><div>${c}</div><div>${amounts[i]/100}</div></div>`, "")}</div>
			</div>`);
	}
}

class CalendarDate {
	constructor(dateOrTime) {
		this.isTime = !!dateOrTime.dateTime;
		this.when = new Date(dateOrTime.dateTime || dateOrTime.date);
		this.options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
	}
	print() {
		return this.isTime ? `${this.when.getHours()}:${this.when.getMinutes()} ${this.when.toLocaleDateString(undefined,this.options)}`
			: this.when.toLocaleDateString(undefined, this.options);
	}
}

class Calendar {
	constructor() {
		if (!window?.configs?.calendarWords) return;
		this.stopped = false;
		this.timer = nowAndEvery(calendarRefreshInterval * 1000, () => this.calendarLoad("calendarExtract", 2));
	}

	calendarLoad(location, rows = 4) {
		if (this.stopped) return;
		let serviceWords = (window?.configs?.calendarWords || "communion prayer service vigil mass").split(" ");
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
					let when = new CalendarDate(item.start);
					let summaryLC = item.summary.toLowerCase();
					if (serviceWords.some(s => summaryLC.indexOf(s) >= 0)) {
						if (rowCount++ < rows) {
							table.push(`${item.summary} </td><td> ${when.print()}</td></tr><tr><td>`);
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
var failCount = 0;
function analytics(message, transaction) {
	try {
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
			appInsights.flush();
		}
	} catch (err) {
		console.log(`Analytics failure ${failCount} ${err.message}`);
		if (failCount++>5) window.location.reload();
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

class Labels {
	constructor() {
		this.strings = {};
		for (const lang in window.strings) {
			this.strings[lang] = {...window.strings?.[lang]||{}, ...configs.strings?.[lang] ||{}}
		}
		window.languageSwitch.observer(this);
		this.changeLanguage();
	}
	changeLanguage(language="en") {
		let labels = document.getElementsByClassName("label");
		for (let i = 0; i<labels.length; i++) {
			let string = this.strings[language]?.[labels[i].id];
			if (string) {
				labels[i].innerHTML = string;
			}
		}
	}
}

$(async () => {
	window.configs = await fetch("config").then(r => r.json()).catch(r=>console.log(r),{});
	window.languageSwitch = new LanguageSwitch(["en","cy"]);
	window.buttons = new Buttons();
	window.slides = new Slides();
	window.services = new Services();
	window.cardTerminal = new CardTerminal();
	window.calendar = new Calendar();
	window.receipts = new Receipts();
	window.romanClock = new RomanClock();
	window.labels = new Labels();
	analytics("Startup " + location.origin);
})
