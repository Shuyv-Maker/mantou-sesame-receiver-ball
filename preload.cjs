const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function toFileRecord(file) {
  const record = {
    path: webUtils.getPathForFile(file),
    name: file.name,
    type: file.type,
    size: file.size,
  };
  if (!record.path) {
    record.bytes = new Uint8Array(await file.arrayBuffer());
  }
  return record;
}

contextBridge.exposeInMainWorld("mantouReceiver", {
  getStatus: () => ipcRenderer.invoke("receiver:status"),
  moveBy: (x, y) => ipcRenderer.invoke("receiver:move-by", x, y),
  showPairing: () => ipcRenderer.invoke("receiver:show-pairing"),
  showContextMenu: () => ipcRenderer.invoke("receiver:show-context-menu"),
  ingestFile: async (file) => ipcRenderer.invoke(
    "receiver:ingest",
    file ? [await toFileRecord(file)] : [],
  ),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("receiver:status", listener);
    return () => ipcRenderer.removeListener("receiver:status", listener);
  },
});
