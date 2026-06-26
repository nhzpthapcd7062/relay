import { RelayClient } from "./relay-client.js";
import { WebRTCManager } from "./webrtc.js";
import { InputManager } from "./input.js";
import { UIManager } from "./ui.js";

// Global states (UI & Window)
const state = {
	relay: null,
	mode: "share", // "share" or "control"
	clientId: null,
	sharingClientId: null,
	controllerClientId: null,
	sharePassword: null,
	screenInfo: null,
	sharingStarting: false,

	// Stream window elements
	streamWindow: null,
	streamVideoEl: null,
	infoPanel: null,
	fpsEl: null,
	netEl: null,
	qualitySelectEl: null,
};

// Initialize UIManager
const ui = new UIManager();

// Logger utility wrapper
function appLog(message, extra) {
	const text = `[App] ${message} ` + (extra !== undefined ? JSON.stringify(extra) : "");
	console.log(text);
	window.rcBridge?.logToServer?.(text).catch(() => { });
}

// 1. WebRTC Manager Initialization
const rtc = new WebRTCManager({
	onSignal: (payload) => {
		send(payload);
	},
	onLog: (message, extra) => {
		appLog(message, extra);
	},
	onStats: (fps, formattedBitrate) => {
		if (state.fpsEl) state.fpsEl.textContent = `${fps} fps`;
		if (state.netEl) state.netEl.textContent = formattedBitrate;
	},
	onRemoteStream: (stream) => {
		attachStreamToViews(stream);
	},
	onDataMessage: (msg) => {
		if (msg.type === "botjs") {
			executeBotCommand(msg);
		} else if (msg.type === "botjsResult") {
			// handle botjsResult if needed
		} else if (msg.type === "changeQuality") {
			rtc.applyQualityProfile(msg.profile).then(() => {
				rtc.tuneSenderEncoding();
			});
		} else if (msg.type === "screenInfo") {
			state.screenInfo = msg;
			appLog("收到 screenInfo (DataChannel)", msg);
		}
	},
	onDataChannelOpen: () => {
		appLog("DataChannel 已就绪");
		if (state.mode === "share") {
			publishScreenInfo();
		}
	},
	getMode: () => state.mode,
	getTargetClientId: () => {
		if (state.mode === "control") {
			return state.sharingClientId;
		}
		return state.controllerClientId;
	}
});

// 2. Input Manager Initialization
const input = new InputManager({
	sendBotAction: (action, args) => {
		if (state.mode !== "control" || !state.sharingClientId) {
			return;
		}
		const payload = {
			type: "botjs",
			action,
			args,
			from: state.clientId,
		};
		if (!rtc.sendDataChannelMessage(payload)) {
			send(payload);
		}
	},
	getScreenInfo: () => state.screenInfo,
	getMode: () => state.mode,
});

// Window Management
function enterFullscreenWindow(win) {
	try {
		win.moveTo(0, 0);
		win.resizeTo(screen.availWidth, screen.availHeight);
	} catch (_err) {
		// Ignore sizing errors
	}
}

function applyStreamWindowMode(isControl) {
	if (!state.streamWindow || state.streamWindow.closed || !state.streamVideoEl) {
		return;
	}

	const doc = state.streamWindow.document;
	doc.title = isControl ? "远程控制画面" : "共享画面";
	doc.body.classList.toggle("control-mode", isControl);
	state.streamVideoEl.style.cursor = isControl ? "none" : "default";
	if (state.infoPanel) {
		state.infoPanel.style.display = isControl ? "block" : "none";
	}
}

async function ensureStreamWindow() {
	if (state.streamWindow && !state.streamWindow.closed && state.streamVideoEl) {
		return state.streamVideoEl;
	}

	const child = window.open("stream.html", "relay-stream-window", "popup=yes,width=1280,height=720");
	if (!child) {
		appLog("子窗口打开失败，请检查是否被系统或策略拦截");
		return null;
	}

	state.streamWindow = child;

	await new Promise((resolve) => {
		const check = () => {
			if (child.document && child.document.getElementById("streamVideo")) {
				resolve();
			} else {
				setTimeout(check, 50);
			}
		};
		check();
	});

	state.streamWindow = child;
	state.streamVideoEl = child.document.getElementById("streamVideo");
	state.infoPanel = child.document.getElementById("infoPanel");
	state.fpsEl = child.document.getElementById("fpsValue");
	state.netEl = child.document.getElementById("netValue");
	state.qualitySelectEl = child.document.getElementById("qualitySelect");

	if (state.qualitySelectEl) {
		state.qualitySelectEl.value = rtc.qualityProfile;
		state.qualitySelectEl.addEventListener("change", async (event) => {
			const profile = event.target?.value || "high";
			const payload = {
				type: "changeQuality",
				profile: profile,
				from: state.clientId,
			};
			if (!rtc.sendDataChannelMessage(payload)) {
				send(payload);
			}
		});
	}

	child.addEventListener("beforeunload", () => {
		state.streamWindow = null;
		state.streamVideoEl = null;
		state.infoPanel = null;
		state.fpsEl = null;
		state.netEl = null;
		state.qualitySelectEl = null;
		rtc.stopStatsLoop();
		refreshControlBindings();
	});

	applyStreamWindowMode(state.mode === "control");
	enterFullscreenWindow(child);
	refreshControlBindings();

	return state.streamVideoEl;
}

async function attachStreamToViews(stream) {
	const childVideo = await ensureStreamWindow();
	if (childVideo) {
		childVideo.srcObject = stream;
		childVideo.focus();
		childVideo.play().catch((err) => {
			appLog("播放远程画面失败，尝试手动触发播放", { message: err.message });
		});
	}
}

function refreshControlBindings() {
	input.unbind();
	const targetVideo = state.streamVideoEl && !state.streamWindow?.closed ? state.streamVideoEl : null;
	if (targetVideo) {
		input.bind(targetVideo);
	}
}

// Mode setting coordination
function setMode(mode) {
	state.mode = mode;
	applyStreamWindowMode(mode === "control");

	if (mode === "control") {
		rtc.startStatsLoop();
	} else {
		rtc.stopStatsLoop();
	}
	refreshControlBindings();

	// Update active tab UI and visible card via UIManager
	ui.setMode(mode);
}

// Relay websocket messaging methods
function connectRelay() {
	const url = ui.getServerUrl();
	if (!url) {
		appLog("请填写转发层地址");
		return;
	}

	if (state.relay) {
		state.relay.close();
	}

	state.relay = new RelayClient(url, {
		onOpen: () => {
			ui.setConnected(true);
			appLog("Relay connected");
		},
		onClose: () => {
			ui.setConnected(false);
			appLog("Relay disconnected");
		},
		onError: (err) => {
			appLog("Relay error", { message: err.message });
		},
		onMessage: (msg) => {
			handleRelayMessage(msg).catch((err) => {
				appLog("handleRelayMessage 异常", { message: err.message, stack: err.stack });
			});
		},
	});

	state.relay.connect();
}

function disconnectRelay() {
	if (state.relay) {
		state.relay.close();
		state.relay = null;
	}
	rtc.cleanupPeer();
	ui.setConnected(false);
}

// Send WS message wrapper
function send(payload) {
	if (!state.relay) {
		appLog("尚未连接 Relay");
		return;
	}
	try {
		state.relay.send(payload);
	} catch (err) {
		appLog("发送失败", { error: err.message, payload });
	}
}

async function startSharingFlow() {
	if (state.mode !== "share") {
		return;
	}

	if (!state.relay) {
		appLog("请先连接 Relay，再开始共享");
		connectRelay();
		return;
	}

	if (state.sharingStarting) {
		return;
	}

	let deviceId = localStorage.getItem("deviceId");
	if (!deviceId) {
		deviceId = Math.random().toString(36).substring(2) + Date.now().toString(36);
		localStorage.setItem("deviceId", deviceId);
	}

	state.sharingStarting = true;
	send({ type: "startSharing", deviceId });
	state.sharingStarting = false;
}

// Bot native command action executor on the shared/be controlled side
async function executeBotCommand(msg) {
	const { action, args = [], from } = msg;
	try {
		if (action === "syncClipboard") {
			const text = args[0];
			if (window.rcBridge?.clipboardWriteText && text) {
				await window.rcBridge.clipboardWriteText(text);
			}
			return;
		}

		const result = await window.rcBridge.botAction(action, args);
		if (action === "moveMouse") return; // Reduce network spam for high-frequency actions
		const reply = {
			type: "botjsResult",
			action,
			result,
			error: null,
			to: from,
		};
		if (!rtc.sendDataChannelMessage(reply)) {
			send(reply);
		}
	} catch (err) {
		appLog("botjs error", { action, args, message: err.message });
		if (action === "moveMouse") return;
		const reply = {
			type: "botjsResult",
			action,
			result: null,
			error: err.message,
			to: from,
		};
		if (!rtc.sendDataChannelMessage(reply)) {
			send(reply);
		}
	}
}

async function publishScreenInfo() {
	if (state.mode !== "share") {
		return;
	}

	if (!rtc.localStream) {
		return;
	}

	const videoTrack = rtc.localStream.getVideoTracks()[0];
	const settings = videoTrack?.getSettings?.() || {};
	const payload = {
		type: "screenInfo",
		captureWidth: Number(settings.width || window.screen.width),
		captureHeight: Number(settings.height || window.screen.height),
		screenWidth: Number(window.screen.width),
		screenHeight: Number(window.screen.height),
		devicePixelRatio: Number(window.devicePixelRatio || 1),
	};

	// Send via WebSocket with target routing
	if (state.controllerClientId) {
		send({ ...payload, to: state.controllerClientId });
	} else {
		send(payload);
	}

	// Also send via DataChannel for reliability
	rtc.sendDataChannelMessage(payload);
}

// Handle signals and message events from WebSocket
async function handleRelayMessage(msg) {
	const type = msg.type;
	if (type !== "pong") {
		appLog(`recv ${type}`, msg);
	}

	// Signalling messages routing
	if (type === "webrtc" && msg.signal?.type) {
		if (state.mode === "share") {
			state.controllerClientId = msg.from;
		}
		const signalResult = await rtc.handleSignal(msg.from, msg.signal);
		if (signalResult === "offer-processed") {
			await publishScreenInfo();
			appLog("屏幕采集与 WebRTC 应答已就绪");
		}
		return;
	}
	if (type === "offer" || type === "answer" || type === "candidate") {
		const normalizedSignal =
			type === "candidate" ? { type: "candidate", candidate: msg.candidate || null } : msg;
		if (state.mode === "share") {
			state.controllerClientId = msg.from;
		}
		const signalResult = await rtc.handleSignal(msg.from, normalizedSignal);
		if (signalResult === "offer-processed") {
			await publishScreenInfo();
			appLog("屏幕采集与 WebRTC 应答已就绪");
		}
		return;
	}

	switch (type) {
		case "connected":
			state.clientId = msg.clientId;
			state.sharePassword = msg.code || null;
			ui.updateSharePassword(state.sharePassword);
			if (!state.sharePassword) {
				startSharingFlow();
			}
			break;

		case "sharingStarted":
			state.sharePassword = msg.code || null;
			ui.updateSharePassword(state.sharePassword);
			appLog("共享 Code 已自动生成，等待控制端输入 Code 连接后再启动采集");
			break;

		case "remoteSharingStopped":
			appLog("收到 remoteSharingStopped", { reason: msg.reason });
			if (state.mode === "control") {
				alert(msg.reason || "共享端已断开连接");
				if (state.streamWindow && !state.streamWindow.closed) {
					state.streamWindow.close();
				}
				setMode("share");
			}
			break;

		case "sharingStopped":
			appLog("收到 sharingStopped", { reason: msg.reason });
			if (state.mode === "share") {
				state.sharePassword = null;
				ui.updateSharePassword(null);
			}
			break;

		case "authenticated":
			state.sharingClientId = msg.sharingClientId || null;
			state.screenInfo = msg.screenInfo || null;
			appLog("认证成功，准备建立 WebRTC 连接", { sharingClientId: state.sharingClientId });
			if (state.sharingClientId) {
				rtc.createControllerOffer(state.sharingClientId);
				appLog("WebRTC offer 已创建并发送");
			}
			break;

		case "screenInfo":
			state.screenInfo = msg;
			break;

		case "botjs":
			await executeBotCommand(msg);
			break;

		case "changeQuality":
			await rtc.applyQualityProfile(msg.profile);
			await rtc.tuneSenderEncoding();
			break;

		case "botjsResult":
			break;

		case "error":
			appLog("服务器错误", { message: msg.message });
			if (msg.message === "已经有其他用户在共享中") {
				appLog("当前已存在被控端共享，本端可直接输入 Code 作为控制端连接");
				break;
			}
			if (state.streamWindow && !state.streamWindow.closed) {
				state.streamWindow.close();
			}
			alert(`服务器错误: ${msg.message}`);
			break;

		default:
			break;
	}
}

// Bind UI event listeners using UIManager
function bindEvents() {
	ui.init({
		onNavChange: (mode) => {
			setMode(mode);
		},
		onSettingsToggle: () => {
			ui.toggleSettingsPanel();
		},
		onCopyCode: () => {
			const codeText = state.sharePassword;
			if (codeText) {
				navigator.clipboard.writeText(codeText)
					.then(() => {
						appLog("连接码已成功复制到剪贴板");
						ui.showCopySuccess();
					})
					.catch((err) => appLog("复制失败", { message: err.message }));
			}
		},
		onConnectClick: (code) => {
			if (!code) {
				appLog("请输入 Code");
				return;
			}
			saveHistory(code);
			send({ type: "stopSharing" });
			setMode("control");
			appLog("尝试连接控制", { code });
			send({ type: "authenticate", code });
		},
		onServerConnectClick: () => {
			connectRelay();
		},
		onDisconnectClick: () => {
			disconnectRelay();
		}
	});

	refreshControlBindings();
}

// History Management
const HISTORY_KEY = "relayHistory";
function getHistory() {
	try {
		return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
	} catch {
		return [];
	}
}
function saveHistory(code) {
	let history = getHistory();
	history = history.filter(c => c !== code); // remove duplicates
	history.unshift(code); // add to top
	if (history.length > 10) history = history.slice(0, 10); // keep max 10
	localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
	refreshHistory();
}
function deleteHistory(code) {
	let history = getHistory();
	history = history.filter(c => c !== code);
	localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
	refreshHistory();
}
function refreshHistory() {
	ui.renderHistory(
		getHistory(),
		(code) => deleteHistory(code),
		(code) => { /* Selection handles input population in ui.js */ }
	);
}

// Initialize Application
setMode("share");
connectRelay();
bindEvents();
refreshHistory();

appLog("准备就绪，正在自动连接 Relay");
