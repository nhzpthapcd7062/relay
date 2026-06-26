const path = require("path");
const fs = require("fs");
const https = require("https");
const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");

const isDev = process.env.NODE_ENV !== "production";
if (isDev) {
	app.commandLine.appendSwitch("ignore-certificate-errors");
}
// Favor smooth rendering and prevent tearing/flickering.
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

let robot = null;
let robotLoadPromise = null;

const BOTJS_RELEASE_TAG = "v0.1.2";
const BOTJS_RELEASE_BASE_URL = `https://github.com/nhzpthapcd7062/botjs/releases/download/${BOTJS_RELEASE_TAG}`;
const BOTJS_DOWNLOAD_TIMEOUT_MS = 120000;

function getNativeBaseUrls() {
	const custom = process.env.BOTJS_NATIVE_BASE_URLS || "";
	const fromEnv = custom
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (fromEnv.length > 0) {
		return fromEnv;
	}

	return [BOTJS_RELEASE_BASE_URL];
}

function loadFromBotDir(botDir) {
	if (!botDir || !fs.existsSync(botDir)) {
		throw new Error(`bot dir not found: ${botDir}`);
	}

	const releaseDir = path.join(botDir, "build", "Release");
	const expectedNode = path.join(releaseDir, "crobot.node");

	if (fs.existsSync(expectedNode)) {
		// Prefer loading native addon directly from unpacked path in packaged builds.
		return require(expectedNode);
	}

	if (fs.existsSync(releaseDir)) {
		const nodeFiles = fs.readdirSync(releaseDir).filter((file) => file.endsWith(".node"));
		if (nodeFiles.length > 0) {
			return require(path.join(releaseDir, nodeFiles[0]));
		}
	}

	return require(botDir);
}

function loadRobotFromLocalCandidates() {
	if (robot) {
		return robot;
	}

	const resourceBase = process.resourcesPath || "";
	const directNativeCandidates = [
		path.join(resourceBase, "native", "crobot.node"),
		path.join(__dirname, "build", "native", `${process.platform}-${process.arch}`, "crobot.node"),
	];
	const botDirs = [
		path.join(resourceBase, "app.asar.unpacked", "node_modules", "botjs"),
		path.join(resourceBase, "app.asar", "node_modules", "botjs"),
		path.join(__dirname, "node_modules", "botjs"),
	];
	const moduleIds = ["botjs", "c-robot"];
	const triedErrors = [];

	for (const nativePath of directNativeCandidates) {
		try {
			if (fs.existsSync(nativePath)) {
				robot = require(nativePath);
				return robot;
			}
		} catch (err) {
			triedErrors.push(`${nativePath}: ${err.message}`);
		}
	}

	for (const botDir of botDirs) {
		try {
			robot = loadFromBotDir(botDir);
			return robot;
		} catch (err) {
			triedErrors.push(`${botDir}: ${err.message}`);
		}
	}

	for (const moduleId of moduleIds) {
		try {
			// eslint-disable-next-line global-require, import/no-dynamic-require
			robot = require(moduleId);
			return robot;
		} catch (err) {
			triedErrors.push(`${moduleId}: ${err.message}`);
		}
	}

	const diagnostics = directNativeCandidates
		.map((item) => `${item} [exists=${fs.existsSync(item)}]`)
		.concat(botDirs.map((item) => `${item} [exists=${fs.existsSync(item)}]`))
		.concat(moduleIds.map((item) => `${item} [module-id]`))
		.join("; ");

	throw new Error(
		`BotJS module is not available. Tried: ${diagnostics}. Errors: ${triedErrors.join(" | ")}`,
	);
}

function getPrebuiltAssetName() {
	if (process.platform === "win32" && process.arch === "x64") {
		return "crobot-win32-x64.node";
	}
	if (process.platform === "darwin" && process.arch === "arm64") {
		return "crobot-darwin-arm64.node";
	}
	throw new Error(`No prebuilt botjs asset for ${process.platform}/${process.arch}`);
}

function safeUnlink(filePath) {
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch (_err) {
		// ignore cleanup errors
	}
}

function downloadFile(url, filePath, redirectCount = 0) {
	return new Promise((resolve, reject) => {
		if (redirectCount > 5) {
			reject(new Error("Too many redirects while downloading botjs native module"));
			return;
		}

		const req = https.get(url, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				resolve(downloadFile(res.headers.location, filePath, redirectCount + 1));
				return;
			}

			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`Download failed: HTTP ${res.statusCode}`));
				return;
			}

			const file = fs.createWriteStream(filePath);
			res.pipe(file);
			file.on("finish", () => {
				file.close(() => resolve());
			});
			file.on("error", (err) => {
				file.close(() => {
					safeUnlink(filePath);
					reject(err);
				});
			});
		});

		req.on("error", (err) => {
			safeUnlink(filePath);
			reject(err);
		});
		req.setTimeout(BOTJS_DOWNLOAD_TIMEOUT_MS, () => {
			req.destroy(new Error("Download timed out"));
		});
	});
}

async function downloadWithRetry(urls, tmpPath, maxAttemptsPerUrl = 2) {
	const errors = [];
	for (const baseUrl of urls) {
		const assetUrl = `${baseUrl}/${getPrebuiltAssetName()}`;
		for (let i = 1; i <= maxAttemptsPerUrl; i += 1) {
			try {
				console.log(`[botjs] downloading native addon (${i}/${maxAttemptsPerUrl}): ${assetUrl}`);
				await downloadFile(assetUrl, tmpPath);
				return;
			} catch (err) {
				errors.push(`${assetUrl} -> ${err.message}`);
			}
		}
	}

	throw new Error(`All download attempts failed: ${errors.join(" | ")}`);
}

async function ensureDownloadedNativeAddon() {
	const nativeDir = path.join(
		app.getPath("userData"),
		"native-modules",
		"botjs",
		`${process.platform}-${process.arch}`,
		BOTJS_RELEASE_TAG,
	);
	const addonPath = path.join(nativeDir, "crobot.node");

	if (fs.existsSync(addonPath)) {
		return addonPath;
	}

	fs.mkdirSync(nativeDir, { recursive: true });
	const tmpPath = `${addonPath}.tmp`;
	const urls = getNativeBaseUrls();
	await downloadWithRetry(urls, tmpPath);
	fs.renameSync(tmpPath, addonPath);

	return addonPath;
}

async function ensureRobotLoaded() {
	if (robot) {
		return robot;
	}

	if (robotLoadPromise) {
		return robotLoadPromise;
	}

	robotLoadPromise = (async () => {
		let localError = null;
		try {
			robot = loadRobotFromLocalCandidates();
			return robot;
		} catch (err) {
			localError = err;
		}

		try {
			const downloadedAddon = await ensureDownloadedNativeAddon();
			try {
				robot = require(downloadedAddon);
			} catch (requireErr) {
				// If cached binary is corrupted or wrong arch, remove and re-download once.
				safeUnlink(downloadedAddon);
				const refreshedAddon = await ensureDownloadedNativeAddon();
				robot = require(refreshedAddon);
				if (!robot) {
					throw requireErr;
				}
			}
			return robot;
		} catch (downloadErr) {
			throw new Error(
				`BotJS load failed. localError=${localError ? localError.message : "none"}; downloadError=${downloadErr.message}. ` +
				"If GitHub is unreachable, set BOTJS_NATIVE_BASE_URLS to your mirror base URL(s), comma-separated.",
			);
		}
	})();

	try {
		return await robotLoadPromise;
	} finally {
		robotLoadPromise = null;
	}
}

function createWindow() {
	// 禁止修改窗口大小以保持布局稳定

	const win = new BrowserWindow({
		width: 600,
		height: 400,
		resizable: false,
		show: false, // 初始隐藏，防止白屏闪烁
		backgroundColor: "#0b0f19", // 设置与暗色主题一致的背景色
		titleBarStyle: "hidden",
		trafficLightPosition: { x: -100, y: -100 },
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
		},
	});

	// 当页面完全渲染并准备就绪后，再显示窗口
	win.once("ready-to-show", () => {
		win.show();
	});

	// f12
	// win.webContents.openDevTools();

	win.loadFile(path.join(__dirname, "src", "index.html"));
}

let botConfigured = false;

async function runBotAction(action, args) {
	const api = await ensureRobotLoaded();

	if (!botConfigured) {
		if (typeof api.setMouseDelay === "function") api.setMouseDelay(0);
		if (typeof api.setKeyboardDelay === "function") api.setKeyboardDelay(0);
		botConfigured = true;
	}

	if (!action || typeof action !== "string") {
		throw new Error("Invalid bot action");
	}

	if (typeof api[action] !== "function") {
		throw new Error(`Unsupported bot action: ${action}`);
	}

	const result = api[action](...(Array.isArray(args) ? args : []));
	return result === undefined ? { ok: true } : result;
}

ipcMain.handle("robot:action", async (_event, payload) => {
	const { action, args } = payload || {};
	return runBotAction(action, args);
});

ipcMain.handle("app:log", async (_event, text) => {
	try {
		await fs.promises.appendFile(path.join(__dirname, "app_logs.txt"), text + "\n");
	} catch (err) {
		// ignore
	}
});

ipcMain.handle("desktop:get-source-id", async () => {
	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: {
			// desktopCapturer 仅支持数值宽高；帧率需在 getUserMedia 里设置
			width: 0,
			height: 0,
		},
	});

	if (!sources || sources.length === 0) {
		throw new Error("No screen source available");
	}

	return sources[0].id;
});

ipcMain.on("window:close", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) win.close();
});

ipcMain.on("window:minimize", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) win.minimize();
});

ipcMain.on("window:maximize", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win) {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	}
});

app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
	// Bypass self-signed cert validation errors for the relay IP or globally in dev mode
	if (url.startsWith("wss://121.41.93.22") || url.includes("121.41.93.22")) {
		event.preventDefault();
		callback(true);
	} else if (isDev) {
		event.preventDefault();
		callback(true);
	} else {
		callback(false);
	}
});

app.whenReady().then(() => {
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
