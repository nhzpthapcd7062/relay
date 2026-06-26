/**
 * Translates local DOM mouse and keyboard events on a stream video element
 * into screen-coordinate-mapped remote control action instructions.
 */
export class InputManager {
	constructor(options = {}) {
		this.sendBotAction = options.sendBotAction || (() => { });
		this.getScreenInfo = options.getScreenInfo || (() => null);
		this.getMode = options.getMode || (() => "control");

		this.pendingTapKeys = new Set();
		this.lastMousePoint = null;
		this.controlUnbind = null;
	}

	getMousePointOnRemote(event, targetVideo) {
		const rect = targetVideo.getBoundingClientRect();
		if (!rect.width || !rect.height || !targetVideo.videoWidth || !targetVideo.videoHeight) {
			return null;
		}

		const scale = Math.min(
			rect.width / targetVideo.videoWidth,
			rect.height / targetVideo.videoHeight
		);
		const displayedW = targetVideo.videoWidth * scale;
		const displayedH = targetVideo.videoHeight * scale;

		const offsetX = (rect.width - displayedW) / 2;
		const offsetY = (rect.height - displayedH) / 2;

		let contentX = event.clientX - rect.left - offsetX;
		let contentY = event.clientY - rect.top - offsetY;

		contentX = Math.max(0, Math.min(displayedW, contentX));
		contentY = Math.max(0, Math.min(displayedH, contentY));

		const xRatio = contentX / displayedW;
		const yRatio = contentY / displayedH;

		const screenInfo = this.getScreenInfo();
		const dpr = Number(screenInfo?.devicePixelRatio || 1);
		const baseW = Number(screenInfo?.screenWidth || screenInfo?.captureWidth || 0) * dpr;
		const baseH = Number(screenInfo?.screenHeight || screenInfo?.captureHeight || 0) * dpr;

		if (!baseW || !baseH) {
			return null;
		}

		return {
			x: Math.round(xRatio * baseW),
			y: Math.round(yRatio * baseH),
		};
	}

	normalizeKey(key) {
		const map = {
			Control: "ctrl",
			Shift: "shift",
			Alt: "alt",
			Meta: "meta",
			Enter: "enter",
			Escape: "esc",
			Backspace: "backspace",
			Tab: "tab",
			ArrowUp: "up",
			ArrowDown: "down",
			ArrowLeft: "left",
			ArrowRight: "right",
			" ": "space",
		};

		if (map[key]) {
			return map[key];
		}

		if (key.length === 1) {
			return key.toLowerCase();
		}

		return null;
	}

	sendMouseMove(point, force = false) {
		if (!point) {
			return;
		}

		if (force) {
			this.lastMousePoint = point;
			this.sendBotAction("moveMouse", [point.x, point.y]);
			return;
		}

		if (
			this.lastMousePoint &&
			this.lastMousePoint.x === point.x &&
			this.lastMousePoint.y === point.y
		) {
			return;
		}

		this.lastMousePoint = point;
		this.sendBotAction("moveMouse", [point.x, point.y]);
	}

	bind(targetVideo) {
		this.unbind();

		if (!targetVideo) {
			return;
		}

		// Use the video's owner document for keyboard events so they fire
		// even when the video element doesn't have strict DOM focus.
		const keyTarget = targetVideo.ownerDocument || document;

		const onMouseMove = (event) => {
			if (this.getMode() !== "control") {
				return;
			}
			const point = this.getMousePointOnRemote(event, targetVideo);
			this.sendMouseMove(point, false);
		};

		const onClick = (event) => {
			if (this.getMode() !== "control") {
				return;
			}
			// Ensure the video element gets focus so keyboard events work
			targetVideo.focus();
			const point = this.getMousePointOnRemote(event, targetVideo);
			if (!point) {
				return;
			}
			this.sendMouseMove(point, true);
			this.sendBotAction("leftClick", []);
		};

		const onContextMenu = (event) => {
			event.preventDefault();
			if (this.getMode() !== "control") {
				return;
			}
			const point = this.getMousePointOnRemote(event, targetVideo);
			if (!point) {
				return;
			}
			this.sendMouseMove(point, true);
			this.sendBotAction("rightClick", []);
		};

		const onDoubleClick = (event) => {
			if (this.getMode() !== "control") {
				return;
			}
			const point = this.getMousePointOnRemote(event, targetVideo);
			if (!point) {
				return;
			}
			this.sendMouseMove(point, true);
			this.sendBotAction("leftDoubleClick", []);
		};

		const onWheel = (event) => {
			if (this.getMode() !== "control") {
				return;
			}
			event.preventDefault();
			const point = this.getMousePointOnRemote(event, targetVideo);
			if (!point) {
				return;
			}
			this.sendMouseMove(point, true);
			// Normalize scroll delta: positive = scroll down, negative = scroll up
			const deltaY = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 5);
			this.sendBotAction("scrollMouse", [0, deltaY]);
		};

		const onKeyDown = (event) => {
			if (this.getMode() !== "control") {
				return;
			}

			const key = this.normalizeKey(event.key);
			if (!key) {
				return;
			}

			const isModifier = ["ctrl", "shift", "alt", "meta"].includes(key);
			const mods = {
				ctrl: event.ctrlKey,
				shift: event.shiftKey,
				alt: event.altKey,
				meta: event.metaKey,
			};

			if (!isModifier && (mods.ctrl || mods.shift || mods.alt || mods.meta)) {
				const tag = `${key}:${mods.ctrl}:${mods.shift}:${mods.alt}:${mods.meta}`;
				if (!this.pendingTapKeys.has(tag)) {
					this.pendingTapKeys.add(tag);
					
					const isWindows = window.rcBridge?.isWindows;
					const isPasteCommand = key === "v" && (isWindows ? mods.ctrl : mods.meta);

					if (isPasteCommand && window.rcBridge?.clipboardReadText) {
						window.rcBridge.clipboardReadText().then((text) => {
							if (text) {
								this.sendBotAction("syncClipboard", [text]);
							}
							this.sendBotAction("keyTap", [key, mods]);
						}).catch(() => {
							this.sendBotAction("keyTap", [key, mods]);
						});
					} else {
						this.sendBotAction("keyTap", [key, mods]);
					}
				}
				event.preventDefault();
				return;
			}

			this.sendBotAction("keyDown", [key]);
			event.preventDefault();
		};

		const onKeyUp = (event) => {
			if (this.getMode() !== "control") {
				return;
			}

			const key = this.normalizeKey(event.key);
			if (!key) {
				return;
			}

			const mods = {
				ctrl: event.ctrlKey,
				shift: event.shiftKey,
				alt: event.altKey,
				meta: event.metaKey,
			};
			const tag = `${key}:${mods.ctrl}:${mods.shift}:${mods.alt}:${mods.meta}`;
			if (this.pendingTapKeys.has(tag)) {
				this.pendingTapKeys.delete(tag);
				event.preventDefault();
				return;
			}

			this.sendBotAction("keyUp", [key]);
			event.preventDefault();
		};

		targetVideo.addEventListener("mousemove", onMouseMove);
		targetVideo.addEventListener("click", onClick);
		targetVideo.addEventListener("contextmenu", onContextMenu);
		targetVideo.addEventListener("dblclick", onDoubleClick);
		targetVideo.addEventListener("wheel", onWheel, { passive: false });
		keyTarget.addEventListener("keydown", onKeyDown);
		keyTarget.addEventListener("keyup", onKeyUp);

		this.controlUnbind = () => {
			targetVideo.removeEventListener("mousemove", onMouseMove);
			targetVideo.removeEventListener("click", onClick);
			targetVideo.removeEventListener("contextmenu", onContextMenu);
			targetVideo.removeEventListener("dblclick", onDoubleClick);
			targetVideo.removeEventListener("wheel", onWheel);
			keyTarget.removeEventListener("keydown", onKeyDown);
			keyTarget.removeEventListener("keyup", onKeyUp);
			this.controlUnbind = null;
		};
	}

	unbind() {
		if (this.controlUnbind) {
			this.controlUnbind();
		}
	}
}
