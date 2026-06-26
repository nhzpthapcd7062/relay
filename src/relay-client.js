export class RelayClient {
    constructor(url, handlers = {}) {
        this.url = url;
        this.handlers = handlers;
        this.ws = null;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.isManualClose = false;
        this.reconnectMs = 2500;
    }

    connect() {
        this.isManualClose = false;
        this._open();
    }

    close() {
        this.isManualClose = true;
        this._clearTimers();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not connected");
        }
        this.ws.send(JSON.stringify(payload));
    }

    _open() {
        this.ws = new WebSocket(this.url);

        this.ws.addEventListener("open", () => {
            this.handlers.onOpen?.();
            this._startHeartbeat();
        });

        this.ws.addEventListener("message", (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handlers.onMessage?.(msg);
            } catch (err) {
                this.handlers.onError?.(new Error(`Invalid JSON message: ${err.message}`));
            }
        });

        this.ws.addEventListener("error", () => {
            this.handlers.onError?.(new Error("WebSocket error"));
        });

        this.ws.addEventListener("close", () => {
            this.handlers.onClose?.();
            this._clearTimers();
            if (!this.isManualClose) {
                this.reconnectTimer = setTimeout(() => this._open(), this.reconnectMs);
            }
        });
    }

    _startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.send({ type: "ping" });
            }
        }, 10000);
    }

    _clearTimers() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}
