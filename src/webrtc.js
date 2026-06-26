import { formatBitrate } from "./utils.js";

/**
 * Manages WebRTC PeerConnection, screen capture, quality profiles,
 * signaling handling, and network stats loop.
 */
export class WebRTCManager {
	constructor(options = {}) {
		this.onSignal = options.onSignal || (() => { });
		this.onLog = options.onLog || (() => { });
		this.onStats = options.onStats || (() => { });
		this.onRemoteStream = options.onRemoteStream || (() => { });
		this.onDataMessage = options.onDataMessage || (() => { });
		this.onDataChannelOpen = options.onDataChannelOpen || (() => { });
		this.getMode = options.getMode || (() => "share");
		this.getTargetClientId = options.getTargetClientId || (() => null);

		this.configuration = {
			iceServers: options.iceServers || [
				// Default fallback for development
				{
					urls: ["stun:121.41.93.22:3478"],
				},
				{
					urls: [
						"turn:121.41.93.22",
						"turn:121.41.93.22:3478?transport=udp",
						"turn:121.41.93.22:3478?transport=tcp"
					],
					username: "app",
					credential: "app",
				},
			],
			iceTransportPolicy: "all",
			iceCandidatePoolSize: 2,
			bundlePolicy: "max-bundle",
		};

		this.pc = null;
		this.localStream = null;
		this.dataChannel = null;
		this.qualityProfile = "high";
		this.pendingRemoteCandidates = [];
		this.statsTimer = null;
		this.lastBytesReceived = 0;
		this.lastStatsAt = 0;
	}

	sendDataChannelMessage(msg) {
		if (this.dataChannel && this.dataChannel.readyState === "open") {
			try {
				this.dataChannel.send(JSON.stringify(msg));
				return true;
			} catch (err) {
				// ignore
			}
		}
		return false;
	}

	shouldSendCandidate(candidateInit) {
		const candidate = String(candidateInit?.candidate || "");
		if (!candidate) {
			return false;
		}
		return true;
	}

	async flushPendingCandidates() {
		if (!this.pc?.remoteDescription) {
			return;
		}

		if (!this.pendingRemoteCandidates.length) {
			return;
		}

		const pending = this.pendingRemoteCandidates.splice(0);
		for (const candidate of pending) {
			try {
				await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
			} catch (err) {
				this.onLog("补充 remote candidate 失败", { message: err.message });
			}
		}
	}

	cleanupPeer() {
		if (this.dataChannel) {
			this.dataChannel.close();
			this.dataChannel = null;
		}
		if (this.pc) {
			this.pc.onicecandidate = null;
			this.pc.ontrack = null;
			this.pc.oniceconnectionstatechange = null;
			this.pc.onconnectionstatechange = null;
			this.pc.ondatachannel = null;
			this.pc.close();
			this.pc = null;
		}
		this.pendingRemoteCandidates = [];
		this.lastBytesReceived = 0;
		this.lastStatsAt = 0;
		this.stopStatsLoop();
	}

	ensurePeer() {
		if (this.pc) {
			return this.pc;
		}

		const pc = new RTCPeerConnection(this.configuration);

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				if (!this.shouldSendCandidate(event.candidate)) {
					this.onLog("跳过不可用 candidate", { candidate: event.candidate.candidate });
					return;
				}
				const to = this.getTargetClientId();
				if (to) {
					this.onSignal({
						type: "webrtc",
						to,
						signal: { type: "candidate", candidate: event.candidate },
					});
				}
			}
		};

		pc.ontrack = (event) => {
			if (this.getMode() === "control") {
				const stream = event.streams[0] || new MediaStream([event.track]);
				this.onRemoteStream(stream);
			}
		};

		pc.oniceconnectionstatechange = () => {
			this.onLog("ICE 状态变化", { state: pc.iceConnectionState });
		};

		pc.onconnectionstatechange = () => {
			this.onLog("Peer 连接状态变化", { state: pc.connectionState });
		};

		if (this.getMode() === "share") {
			pc.ondatachannel = (event) => {
				this.onLog("DataChannel connected on share side!");
				this.dataChannel = event.channel;
				this.dataChannel.onopen = () => {
					this.onLog("DataChannel opened on share side");
					this.onDataChannelOpen();
				};
				this.dataChannel.onmessage = (e) => {
					try {
						const msg = JSON.parse(e.data);
						this.onDataMessage(msg);
					} catch (err) {
						this.onLog("DataChannel 消息解析失败", { message: err.message });
					}
				};
			};
		}

		this.pc = pc;
		return pc;
	}

	async createControllerOffer(sharingClientId) {
		this.cleanupPeer();
		const pc = this.ensurePeer();

		this.dataChannel = pc.createDataChannel("control");
		this.dataChannel.onopen = () => {
			this.onLog("DataChannel opened on control side");
			this.onDataChannelOpen();
		};
		this.dataChannel.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data);
				this.onDataMessage(msg);
			} catch (err) {
				this.onLog("DataChannel 消息解析失败", { message: err.message });
			}
		};

		const offer = await pc.createOffer({ offerToReceiveVideo: true });
		await pc.setLocalDescription(offer);

		this.onSignal({
			type: "webrtc",
			to: sharingClientId,
			signal: offer,
		});

		if (this.getMode() === "control") {
			this.startStatsLoop();
		}
	}

	async handleSignal(from, signal) {
		if (!signal || !signal.type) {
			return;
		}

		const pc = this.ensurePeer();

		if (signal.type === "offer") {
			this.onLog("收到控制端连接请求，开始启动屏幕采集");
			await this.ensureLocalStream();

			const hasTrack = pc.getSenders().some((s) => s.track && s.track.kind === "video");
			if (!hasTrack) {
				for (const track of this.localStream.getTracks()) {
					pc.addTrack(track, this.localStream);
				}
			}
			await this.tuneSenderEncoding();

			await pc.setRemoteDescription(new RTCSessionDescription(signal));
			await this.flushPendingCandidates();
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);

			this.onSignal({
				type: "webrtc",
				to: from,
				signal: answer,
			});
			return "offer-processed";
		}

		if (signal.type === "answer") {
			await pc.setRemoteDescription(new RTCSessionDescription(signal));
			await this.flushPendingCandidates();
			await this.tuneSenderEncoding();
			return "answer-processed";
		}

		if (signal.type === "candidate") {
			if (signal.candidate) {
				if (pc.remoteDescription) {
					await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
				} else {
					this.pendingRemoteCandidates.push(signal.candidate);
				}
			}
			return "candidate-processed";
		}
	}

	async ensureLocalStream() {
		if (this.localStream) {
			return this.localStream;
		}

		let stream = null;

		if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function") {
			try {
				stream = await navigator.mediaDevices.getDisplayMedia({
					video: {
						frameRate: { ideal: 120, min: 60, max: 144 },
						width: { ideal: 3840, max: 3840 },
						height: { ideal: 2160, max: 2160 },
					},
					audio: false,
				});
			} catch (err) {
				this.onLog("getDisplayMedia 不可用，尝试 Electron 兜底采集", { message: err.message });
			}
		}

		if (!stream) {
			if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
				throw new Error("当前环境不支持屏幕采集，请检查 Electron/系统权限");
			}

			try {
				const sourceId = await window.rcBridge.getDesktopSourceId();

				stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						mandatory: {
							chromeMediaSource: "desktop",
							chromeMediaSourceId: sourceId,
							maxWidth: 3840,
							maxHeight: 2160,
							minFrameRate: 60,
							maxFrameRate: 144,
						},
					},
				});
			} catch (err) {
				this.onLog("Electron 兜底采集失败", { message: err.message });
				throw new Error(`Electron 兜底采集失败: ${err.message}`);
			}
		}

		this.localStream = stream;
		await this.applyQualityProfile(this.qualityProfile);
		return this.localStream;
	}

	async applyQualityProfile(profile) {
		this.qualityProfile = profile;
		if (!this.localStream) {
			return;
		}

		const track = this.localStream.getVideoTracks?.()[0];
		if (!track || typeof track.applyConstraints !== "function") {
			return;
		}

		const profileMap = {
			low: {
				width: { ideal: 1280 },
				height: { ideal: 720 },
				frameRate: { ideal: 60, min: 60, max: 60 },
			},
			medium: {
				width: { ideal: 1920 },
				height: { ideal: 1080 },
				frameRate: { ideal: 60, min: 60, max: 60 },
			},
			high: {
				width: { ideal: 3840 },
				height: { ideal: 2160 },
				frameRate: { ideal: 120, min: 60, max: 144 },
			},
		};

		const constraints = profileMap[profile] || profileMap.high;
		try {
			await track.applyConstraints(constraints);
			track.contentHint = profile === "high" ? "detail" : "motion";
			this.onLog("已应用清晰度配置", { profile });
		} catch (err) {
			this.onLog("清晰度切换失败", { profile, message: err.message });
		}
	}

	async tuneSenderEncoding() {
		if (!this.pc) {
			return;
		}
		const sender = this.pc.getSenders().find((item) => item.track && item.track.kind === "video");
		if (
			!sender ||
			typeof sender.getParameters !== "function" ||
			typeof sender.setParameters !== "function"
		) {
			return;
		}

		try {
			const params = sender.getParameters() || {};
			if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
				params.encodings = [{}];
			}
			params.degradationPreference = "maintain-framerate";
			
			const maxBitrates = { high: 100000000, medium: 50000000, low: 10000000 };
			params.encodings[0].maxBitrate = maxBitrates[this.qualityProfile] || 8000000;
			
			delete params.encodings[0].maxFramerate;
			params.encodings[0].priority = "high";
			await sender.setParameters(params);
		} catch (err) {
			this.onLog("视频编码参数调整失败", { message: err.message });
		}
	}

	startStatsLoop() {
		this.stopStatsLoop();
		this.lastBytesReceived = 0;
		this.lastStatsAt = 0;
		this.statsTimer = window.setInterval(async () => {
			await this.updateStreamStats();
		}, 1000);
	}

	stopStatsLoop() {
		if (this.statsTimer) {
			window.clearInterval(this.statsTimer);
			this.statsTimer = null;
		}
	}

	async updateStreamStats() {
		if (!this.pc) {
			return;
		}

		try {
			const stats = await this.pc.getStats();
			let fps = 0;
			let bytesReceived = 0;
			let bitrate = 0;

			stats.forEach((report) => {
				if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
					fps = Number(report.framesPerSecond || 0);
					bytesReceived = Number(report.bytesReceived || 0);
				}
			});

			const now = Date.now();
			if (this.lastStatsAt && bytesReceived > this.lastBytesReceived) {
				const seconds = (now - this.lastStatsAt) / 1000;
				if (seconds > 0) {
					bitrate = ((bytesReceived - this.lastBytesReceived) * 8) / seconds;
				}
			}
			this.lastBytesReceived = bytesReceived;
			this.lastStatsAt = now;

			this.onStats(Math.round(fps), formatBitrate(bitrate));
		} catch (err) {
			this.onLog("读取实时统计失败", { message: err.message });
		}
	}
}
