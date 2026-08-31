import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_PORT,
  LocalBridgeServer,
} from "./bridge-server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTOCOL_SCHEME = "mantousesame";
const BALL_SIZE = 88;

let ballWindow = null;
let tray = null;
let bridge = null;
let isQuitting = false;
let lastTransferError = "";

function buildTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#79c9ff"/><stop offset="1" stop-color="#2d7fe8"/></linearGradient></defs>',
    '<circle cx="32" cy="32" r="28" fill="url(#g)" stroke="#f9fbff" stroke-width="4"/>',
    '<path d="M19 35c7 5 19 5 26 0" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>',
    '<circle cx="24" cy="27" r="2" fill="#fff"/><circle cx="40" cy="27" r="2" fill="#fff"/>',
    "</svg>",
  ].join("");
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
  );
}

function focusBall() {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  ballWindow.showInactive();
  ballWindow.setAlwaysOnTop(true, "screen-saver");
}

function publishStatus() {
  const status = bridge?.getStatus();
  if (status && ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send("receiver:status", status);
  }
  refreshTrayMenu();
}

async function showPairingInstructions() {
  if (!bridge) return;
  const status = bridge.getStatus();
  const message = status.paired
    ? "收图球已连接到「" + status.projectName + "」。\n\n如要换一个项目，请在网站中切换项目后点击「连接 Windows 收图球」。网站会自动改接，无需复制配对码。"
    : "1. 打开「馒头芝麻」网站的「我的创作」。\n2. 点击「连接 Windows 收图球」。\n3. 网站会自动启动并连接小球，无需输入配对码。\n4. 连接成功后，把本地图片拖到蓝色小球上。\n\n如果自动连接失败，才使用下面的备用配对码：\n" + status.pairingCode;

  await dialog.showMessageBox(ballWindow || undefined, {
    type: "info",
    title: "馒头芝麻收图球",
    message: status.paired ? "收图球已配对" : "连接网站项目",
    detail: message,
    buttons: ["复制备用配对码", "关闭"],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) clipboard.writeText(status.pairingCode);
  });
}

function closeReceiver() {
  if (isQuitting) return;
  isQuitting = true;
  app.quit();
}

function showReceiverContextMenu() {
  const status = bridge?.getStatus();
  const connectionLabel = status?.paired
    ? "已连接：" + status.projectName
    : "尚未连接网站项目";
  const menu = Menu.buildFromTemplate([
    { label: "馒头芝麻收图球", enabled: false },
    { label: connectionLabel, enabled: false },
    { type: "separator" },
    {
      label: "查看连接说明",
      click: () => {
        void showPairingInstructions();
      },
    },
    ...(lastTransferError ? [{
      label: "查看最近失败原因",
      click: () => {
        void dialog.showMessageBox(ballWindow || undefined, {
          type: "warning",
          title: "图片未送达",
          message: "最近一次传送没有完成",
          detail: lastTransferError,
          buttons: ["知道了"],
        });
      },
    }] : []),
    { type: "separator" },
    {
      label: "关闭收图球",
      click: closeReceiver,
    },
  ]);
  menu.popup({ window: ballWindow || undefined });
}

function refreshTrayMenu() {
  if (!tray || !bridge) return;
  const status = bridge.getStatus();
  const connectionLabel = status.paired
    ? "已连接：" + status.projectName
    : "未连接网站项目";

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "馒头芝麻收图球", enabled: false },
    { label: connectionLabel, enabled: false },
    { type: "separator" },
    {
      label: "显示收图球",
      click: focusBall,
    },
    {
      label: "复制备用配对码",
      click: () => clipboard.writeText(status.pairingCode),
    },
    {
      label: "查看配对说明",
      click: () => {
        void showPairingInstructions();
      },
    },
    { type: "separator" },
    {
      label: "退出收图球",
      click: closeReceiver,
    },
  ]));
  tray.setToolTip("馒头芝麻收图球 · " + connectionLabel);
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.on("click", focusBall);
  refreshTrayMenu();
}

function createBallWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  ballWindow = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: workArea.x + workArea.width - BALL_SIZE - 28,
    y: workArea.y + workArea.height - BALL_SIZE - 38,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    title: "馒头芝麻收图球",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ballWindow.setAlwaysOnTop(true, "screen-saver");
  ballWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWindow.setMenuBarVisibility(false);
  ballWindow.removeMenu();
  ballWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  ballWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  ballWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  ballWindow.once("ready-to-show", () => {
    ballWindow?.showInactive();
    publishStatus();
  });

  ballWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      isQuitting = true;
      app.quit();
    }
  });
  ballWindow.on("closed", () => {
    ballWindow = null;
  });
}

function installIpcHandlers() {
  ipcMain.handle("receiver:status", () => bridge?.getStatus() || null);

  ipcMain.handle("receiver:move-by", (_event, rawX, rawY) => {
    if (!ballWindow || ballWindow.isDestroyed()) return;
    const deltaX = Math.max(-120, Math.min(120, Number(rawX) || 0));
    const deltaY = Math.max(-120, Math.min(120, Number(rawY) || 0));
    const [x, y] = ballWindow.getPosition();
    ballWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY), false);
  });

  ipcMain.handle("receiver:show-pairing", async () => {
    await showPairingInstructions();
    return bridge?.getStatus() || null;
  });

  ipcMain.handle("receiver:show-context-menu", () => {
    showReceiverContextMenu();
  });

  ipcMain.handle("receiver:ingest", async (_event, files) => {
    if (!bridge) {
      lastTransferError = "收图球尚未启动完成。";
      refreshTrayMenu();
      return [{ name: "图片", ok: false, message: lastTransferError }];
    }
    const candidates = Array.isArray(files) ? files.slice(0, 12) : [];
    if (candidates.length === 0) {
      lastTransferError = "没有检测到可上传的图片。请重新拖入本地图片文件。";
      refreshTrayMenu();
      return [{ name: "图片", ok: false, message: lastTransferError }];
    }

    const results = [];
    let transferError = "";
    for (const file of candidates) {
      try {
        const result = await bridge.publishDroppedFile(file);
        results.push({ name: file?.name || "图片", ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : "图片传送失败。";
        if (!transferError) transferError = message;
        results.push({
          name: file?.name || "图片",
          ok: false,
          message,
        });
      }
    }
    lastTransferError = transferError;
    refreshTrayMenu();
    return results;
  });
}

function registerProtocol() {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

function handleProtocolArguments(argumentsList) {
  const target = argumentsList.find((value) =>
    typeof value === "string" && value.toLowerCase().startsWith(PROTOCOL_SCHEME + "://"),
  );
  if (!target) return;
  let launchUrl;
  try {
    launchUrl = new URL(target);
  } catch {
    return;
  }
  const route = (launchUrl.hostname || launchUrl.pathname.replace(/^\//, "")).toLowerCase();
  const pairingToken = launchUrl.searchParams.get("token")?.trim().toUpperCase() || "";
  focusBall();
  if (route === "receiver" || route === "pair") {
    if (pairingToken && bridge?.setPairingToken(pairingToken)) return;
    void showPairingInstructions();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    handleProtocolArguments(commandLine);
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolArguments([url]);
  });

  app.whenReady().then(async () => {
    registerProtocol();
    bridge = new LocalBridgeServer({ port: BRIDGE_PORT, appVersion: app.getVersion() });
    bridge.on("status", publishStatus);

    try {
      await bridge.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        "无法启动馒头芝麻收图球",
        "本地收图桥端口 " + BRIDGE_PORT + " 无法使用。\n\n" + detail,
      );
      app.quit();
      return;
    }

    installIpcHandlers();
    createTray();
    createBallWindow();
    handleProtocolArguments(process.argv);
  });

  app.on("before-quit", () => {
    isQuitting = true;
    void bridge?.stop();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}
