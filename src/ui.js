export class UIManager {
	constructor() {
		this.els = {
			serverUrl: document.getElementById("serverUrl"),
			serverConnectBtn: document.getElementById("serverConnectBtn"),
			connectBtn: document.getElementById("connectBtn"),
			disconnectBtn: document.getElementById("disconnectBtn"),
			password: document.getElementById("password"),
			sharePassword: document.getElementById("sharePassword"),
			connectState: document.getElementById("connectState"),
			settingsBtn: document.getElementById("settingsBtn"),
			settingsBackdrop: document.getElementById("settingsBackdrop"),
			settingsCloseBtn: document.getElementById("settingsCloseBtn"),
			settingsPanel: document.getElementById("settingsPanel"),
			copyCodeBtn: document.getElementById("copyCodeBtn"),
			clearCodeBtn: document.getElementById("clearCodeBtn"),
			navHomeBtn: document.getElementById("navHomeBtn"),
			navControlBtn: document.getElementById("navControlBtn"),
			cardShare: document.getElementById("cardShare"),
			cardControl: document.getElementById("cardControl"),
			historySection: document.getElementById("historySection"),
			historyList: document.getElementById("historyList"),
		};
	}

	init(callbacks = {}) {
		const {
			onNavChange,
			onSettingsToggle,
			onCopyCode,
			onConnectClick,
			onServerConnectClick,
			onDisconnectClick,
		} = callbacks;

		const windowControls = document.getElementById("windowControls");
		if (windowControls && window.rcBridge) {
			windowControls.style.display = "flex";

			document.getElementById("winClose")?.addEventListener("click", () => {
				window.rcBridge.windowClose();
			});
			document.getElementById("winMinimize")?.addEventListener("click", () => {
				window.rcBridge.windowMinimize();
			});
			document.getElementById("winMaximize")?.addEventListener("click", () => {
				window.rcBridge.windowMaximize();
			});
		}

		// Navigation switches
		this.els.navHomeBtn?.addEventListener("click", () => {
			onNavChange?.("share");
		});
		this.els.navControlBtn?.addEventListener("click", () => {
			onNavChange?.("control");
		});

		// Settings Toggle
		this.els.settingsBtn?.addEventListener("click", () => {
			if (onSettingsToggle) {
				onSettingsToggle();
			} else {
				this.toggleSettingsPanel();
			}
		});

		// Modal Close Logic
		this.els.settingsCloseBtn?.addEventListener("click", () => {
			this.els.settingsBackdrop?.classList.add("hidden");
		});
		this.els.settingsBackdrop?.addEventListener("click", (e) => {
			if (e.target === this.els.settingsBackdrop) {
				this.els.settingsBackdrop.classList.add("hidden");
			}
		});

		// Copy functionality
		this.els.copyCodeBtn?.addEventListener("click", () => {
			onCopyCode?.();
		});

		// Clear Code
		if (this.els.password && this.els.clearCodeBtn) {
			const toggleClearBtn = () => {
				this.els.clearCodeBtn.style.display = this.els.password.value.length > 0 ? "flex" : "none";
			};
			this.els.password.addEventListener("input", toggleClearBtn);
			toggleClearBtn();

			this.els.clearCodeBtn.addEventListener("click", () => {
				this.els.password.value = "";
				this.els.password.focus();
				toggleClearBtn();
			});
		}

		// Connect Remote Control
		this.els.connectBtn?.addEventListener("click", () => {
			const code = this.els.password.value.trim();
			onConnectClick?.(code);
		});

		this.els.serverConnectBtn?.addEventListener("click", () => {
			onServerConnectClick?.();
			this.els.settingsBackdrop?.classList.add("hidden");
		});

		// Disconnect Relay Client
		this.els.disconnectBtn?.addEventListener("click", () => {
			onDisconnectClick?.();
			this.els.settingsBackdrop?.classList.add("hidden");
		});
	}

	renderHistory(historyCodes, onDelete, onSelect) {
		const section = this.els.historySection;
		const list = this.els.historyList;
		if (!section || !list) return;

		if (!historyCodes || historyCodes.length === 0) {
			section.style.display = "none";
			return;
		}

		section.style.display = "flex";
		list.innerHTML = "";

		historyCodes.forEach(code => {
			const item = document.createElement("div");
			item.className = "history-item";
			
			const codeSpan = document.createElement("span");
			codeSpan.className = "history-code";
			codeSpan.textContent = code;
			
			const delBtn = document.createElement("button");
			delBtn.className = "history-del-btn";
			delBtn.title = "删除记录";
			delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"></path></svg>`;
			
			item.addEventListener("click", (e) => {
				if (e.target.closest(".history-del-btn")) {
					onDelete?.(code);
				} else {
					this.els.password.value = code;
					onSelect?.(code);
				}
			});

			item.appendChild(codeSpan);
			item.appendChild(delBtn);
			list.appendChild(item);
		});
	}

	setMode(mode) {
		if (mode === "share") {
			this.els.navHomeBtn?.closest('.header-nav')?.classList.remove("control-mode");
			this.els.navHomeBtn?.classList.add("active");
			this.els.navControlBtn?.classList.remove("active");
			this.els.cardShare?.classList.remove("hidden");
			this.els.cardControl?.classList.add("hidden");
		} else if (mode === "control") {
			this.els.navHomeBtn?.closest('.header-nav')?.classList.add("control-mode");
			this.els.navHomeBtn?.classList.remove("active");
			this.els.navControlBtn?.classList.add("active");
			this.els.cardShare?.classList.add("hidden");
			this.els.cardControl?.classList.remove("hidden");
		}
	}

	setConnected(online) {
		this.els.connectState?.classList.toggle("online", online);
		this.els.connectState?.classList.toggle("offline", !online);
	}

	updateSharePassword(code) {
		if (this.els.sharePassword) {
			this.els.sharePassword.textContent = code || "- - - - - -";
		}
	}

	toggleSettingsPanel() {
		this.els.settingsBackdrop?.classList.toggle("hidden");
	}

	getServerUrl() {
		return this.els.serverUrl?.value.trim() || "";
	}

	showCopySuccess() {
		const btn = this.els.copyCodeBtn;
		if (!btn) return;
		btn.classList.add("copied");
		const iconCopy = btn.querySelector(".icon-copy");
		const iconCheck = btn.querySelector(".icon-check");
		if (iconCopy && iconCheck) {
			iconCopy.style.display = "none";
			iconCheck.style.display = "block";
		}
		setTimeout(() => {
			btn.classList.remove("copied");
			if (iconCopy && iconCheck) {
				iconCopy.style.display = "block";
				iconCheck.style.display = "none";
			}
		}, 1500);
	}
}
