const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rcBridge", {
    botAction: async (action, args = []) => ipcRenderer.invoke("robot:action", { action, args }),
    getDesktopSourceId: async () => ipcRenderer.invoke("desktop:get-source-id"),
    logToServer: async (text) => ipcRenderer.invoke("app:log", text),
	isWindows: process.platform === "win32",
	windowClose: () => ipcRenderer.send("window:close"),
	windowMinimize: () => ipcRenderer.send("window:minimize"),
	windowMaximize: () => ipcRenderer.send("window:maximize")
});
