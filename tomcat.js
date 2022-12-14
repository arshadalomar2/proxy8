import * as puppeteer from "puppeteer";
import { Server } from "socket.io";
import { default as cfg } from "./config.js"

//////////////////////////
// BROWSER / Core APIs
/////////////////////////

const browser = await puppeteer.launch({
	headless: true,
	defaultViewport: {
		width: 1280,
		height: 720,
		hasTouch: false,
		isLandscape: true,
		isMobile: false,
		deviceScaleFactor: 1
	},
	args: [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-web-security",
		"--disable-dev-shm-usage",
		"--disable-infobars",
		"--disable-features=site-per-process",
		"--disable-gpu",
		"--window-size=1280,720",
		"--window-position=0,0"
	],
	pipe: true,
	product: "chrome",
	dumpio: true,
	timeout: 10000
});

/**
 * @type {(puppeteer.Page)[]}
 */
const clients = [];

/**
 * @param {{ readonly width?: number; readonly height?: number; readonly useTor?: boolean; } | null | undefined} config 
 */
async function newSession(config) {
	if (config == null) {
		console.warn("Session creation ignored, missing configuration");
		return -1;
	}
	const width = config.width;
	const height = config.height;
	const useTor = config.useTor;
	if (width == null || height == null || useTor == null) {
		console.warn("Session creation ignore, invalid configuration detected");
		return -1;
	}
	if (width < 360 || width > 2048 || height < 360 || height > 2048) {
		console.warn("Session creation ignored, because invalid dimension configuration detected.");
		return -1;
	}

	const torProxyAddress = cfg.tomcat.torProxyAddress;
	const proxyAddress = cfg.tomcat.proxyAddress;
	const context = await browser.createIncognitoBrowserContext({
		proxyServer: (torProxyAddress != null && useTor) ? torProxyAddress : (proxyAddress == null ? void 0 : proxyAddress),
		proxyBypassList: []
	});
	const page = await context.newPage();
	await page.setCacheEnabled(true);
	await page.setJavaScriptEnabled(true);
	await page.setGeolocation({
		accuracy: 0,
		latitude: 0,
		longitude: 0
	});
	await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/109.0", {
		architecture: "",
		bitness: "",
		brands: [],
		fullVersion: "",
		fullVersionList: [],
		mobile: false,
		model: "",
		platform: "",
		platformVersion: "",
		wow64: false
	});
	await page.setViewport({
		width,
		height,
		hasTouch: false,
		isLandscape: true,
		isMobile: false,
		deviceScaleFactor: 1
	});

	// hook popups, force open them in current window
	context.on("targetcreated", async (e) => {
		const opener = e.opener();
		if (opener != null) {
			const page = await opener.page();
			if (page != null) {
				await page.goto(e.url(), {
					referer: opener.url(),
					timeout: 10000,
					waitUntil: "domcontentloaded"
				});
			}
			// close hanging page
			await (await e.page())?.close({ runBeforeUnload: false });
		}
	});

	const id = clients.length;
	clients[id] = page;
	return id;
}

/**
 * @param {number} id 
 */
function hasSession(id) {
	return clients[id] != null;
}

/**
 * @param {string} url 
 */
function checkUrl(url) {
	const hostname = new URL(url).hostname;
	// for security reasons, reject all requests to localhost
	if (hostname == "localhost")
		return false;
	
	// reject access to lan
	const n = hostname.split(".");
	if (n.length == 4) {
		if (n[0] == "10") // 10.0.0.0/8
			return false;
		if (n[0] == "127") // 127.0.0.0/8
			return false;
		if (n[0] == "192" && n[1] == "168") // 192.168.0.0/16
			return false;
	}
	return true;
}

/**
 * @param {number} id 
 * @param {string} url 
 */
async function navigate(id, url) {
	try {
		const page = clients[id];
		// if (!checkUrl(url))
		// 	url = "http://google.com";
		await page.goto(url, {
			referer: "",
			waitUntil: "domcontentloaded",
			timeout: 20000
		});
		return true;
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 */
async function sync(id) {
	try {
		const page = clients[id];
		const buf = await page.screenshot({
			encoding: "binary",
			type: "jpeg",
			fromSurface: true,
			fullPage: false,
			quality: 50,
			omitBackground: true
		});
		return { buf, url: page.url() };
	} catch(err) {
		console.log(err);
		return null;
	}
}

/**
 * @param {number} id 
 * @param {{ readonly type: string; readonly x: number; readonly y: number; readonly button: string; }} event 
 */
async function dispatchMouseEvent(id, event) {
	try {
		const page = clients[id];
		const type = event.type;
		const x = event.x;
		const y = event.y;
		const button = event.button;

		switch (type) {
			case "mousedown":
				await page.mouse.down({ button, clickCount: 1 });
				return true;
			case "mouseup":
				await page.mouse.up({ button, clickCount: 1 });
				return true;
			case "mousemove":
				await page.mouse.move(x, y, { steps: 1 });
				return true;
			default:
				throw new Error("Invalid event type: " + type);
		}
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 * @param {{ readonly type: string; readonly deltaX: number; readonly deltaY: number; }} event 
 */
async function dispatchWheelEvent(id, event) {
	try {
		const page = clients[id];
		const type = event.type;
		const deltaX = event.deltaX;
		const deltaY = event.deltaY;

		switch (type) {
			case "wheel":
				await page.mouse.wheel({ deltaX, deltaY });
				return true;
			default:
				throw new Error("Invalid event type: " + type);
		}
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 * @param {{ readonly type: string; readonly key: string; }} event 
 */
async function dispatchKeyboardEvent(id, event) {
	try {
		const page = clients[id];
		const type = event.type;
		const key = event.key;

		switch (type) {
			case "keydown":
				await page.keyboard.down(key);
				return true;
			case "keyup":
				await page.keyboard.up(key);
				return true;
			default:
				throw new Error("Invalid event type: " + type);
		}
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 */
async function goBack(id) {
	try {
		const page = clients[id];
		return await page.goBack({
			waitUntil: "domcontentloaded",
			timeout: 15000
		}) != null;
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 */
async function goForward(id) {
	try {
		const page = clients[id];
		return await page.goForward({
			waitUntil: "domcontentloaded",
			timeout: 15000
		}) != null;
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 */
async function refresh(id) {
	try {
		const page = clients[id];
		return await page.reload({
			waitUntil: "domcontentloaded",
			timeout: 15000
		}) != null;
	} catch(err) {
		console.log(err);
		return false;
	}
}

/**
 * @param {number} id 
 */
async function endSession(id) {
	try {
		const page = clients[id];
		await page.close({ runBeforeUnload: false });
		await page.browserContext().close();
		delete clients[id];
		return true;
	} catch(err) {
		console.log(err);
		return false;
	}
}

const tomcat = {
	newSession,
	hasSession,
	navigate,
	sync,
	dispatchMouseEvent,
	dispatchWheelEvent,
	dispatchKeyboardEvent,
	goBack,
	goForward,
	refresh,
	endSession
};


//////////////////////////
// Extended APIs for NodeJs http server
//////////////////////////

function bind(httpServer) {
	const io = new Server(httpServer, {
		connectTimeout: 25000,
		pingTimeout: 8000,
		pingInterval: 20000,
		httpCompression: true,
		perMessageDeflate: true,
		upgradeTimeout: 8000,
		destroyUpgrade: true,
		destroyUpgradeTimeout: 1000,
		maxHttpBufferSize: 1024
	});

	io.on("connection", (socket) => {
		// emit connect message again to notify the client
		socket.emit("connected", true);
		socket.setMaxListeners(0);

		socket.on("new_session", async (prop) => {
			const id = await newSession(prop);
			if (id < 0) {
				socket.emit("invalid_session");
				return;
			}
			socket.emit("session_id", id);

			const timer = setInterval(async () => {
				const data = await sync(id);
				if (data != null) {
					socket.emit("data", data);
				}
			}, 100);

			socket.on("disconnect", async () => {
				clearInterval(timer);
				await endSession(id);
				socket.removeAllListeners();
				socket.disconnect(true);
			});

			// event listeners
			socket.on("mouseevent", (e) => dispatchMouseEvent(id, e));
			socket.on("wheelevent", (e) => dispatchWheelEvent(id, e));
			socket.on("keyboardevent", (e) => dispatchKeyboardEvent(id, e));
			socket.on("goback", () => goBack(id));
			socket.on("goforward", () => goForward(id));
			socket.on("refresh", () => refresh(id));
			socket.on("navigate", (url) => navigate(id, url));
		});
	});
};

export { bind };
export default tomcat;
