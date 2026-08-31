import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export const BRIDGE_PORT = 49731;
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

// Keep this allowlist intentionally small. A native receiver must never accept
// pairing commands from an arbitrary webpage on the local network.
export const DEFAULT_ALLOWED_PARENT_ORIGINS = Object.freeze([
  "https://mantou-sesame-knowledge-studio.qishuyv.chatgpt.site",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const ACCEPTED_IMAGE_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
]);
const ACCEPTED_IMAGE_MIME_TYPES = new Set(ACCEPTED_IMAGE_TYPES.values());

function randomPairToken() {
  return "MS-" + randomBytes(12).toString("hex").toUpperCase();
}

function randomTransferId() {
  return "image_" + randomBytes(12).toString("hex");
}

function safeText(value, maxLength = 120) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function safeFileName(value) {
  const raw = safeText(value, 180) || "未命名图片";
  return raw.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_");
}

function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPairToken(value) {
  return typeof value === "string" && /^MS-[A-F0-9]{24}$/.test(value);
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function errorPayload(code, message) {
  return {
    type: "error",
    version: BRIDGE_PROTOCOL_VERSION,
    code,
    message,
  };
}

function makeBridgeHtml() {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>馒头芝麻本地收图桥</title>",
    '    <link rel="stylesheet" href="/bridge.css" />',
    "  </head>",
    "  <body>",
    '    <p id="bridge-status" aria-live="polite">正在连接收图球…</p>',
    '    <script src="/bridge.js"></script>',
    "  </body>",
    "</html>",
  ].join("\n");
}

function makeBridgeCss() {
  return [
    ":root { color-scheme: light; }",
    "body { margin: 0; padding: 8px; font-family: system-ui, sans-serif; color: #5b5147; background: transparent; }",
    "#bridge-status { margin: 0; font-size: 12px; }",
  ].join("\n");
}

function makeBridgeScript({ port, allowedOrigins }) {
  const config = JSON.stringify({
    port,
    protocol: BRIDGE_PROTOCOL_VERSION,
    allowedOrigins,
  });

  return [
    "(() => {",
    '  "use strict";',
    "",
    "  const CONFIG = " + config + ";",
    "  const allowedOrigins = new Set(CONFIG.allowedOrigins);",
    '  const statusElement = document.getElementById("bridge-status");',
    '  const localSocketOrigin = "ws://127.0.0.1:" + CONFIG.port + "/socket";',
    "  let parentOrigin = inferParentOrigin();",
    "  let session = null;",
    "  let pendingImage = null;",
    "  let socket = null;",
    "",
    "  function inferParentOrigin() {",
    "    try {",
    "      const origin = new URL(document.referrer).origin;",
    "      return allowedOrigins.has(origin) ? origin : null;",
    "    } catch {",
    "      return null;",
    "    }",
    "  }",
    "",
    "  function safeString(value, max) {",
    '    return typeof value === "string" ? value.trim().slice(0, max) : "";',
    "  }",
    "",
    "  function setStatus(message) {",
    "    if (statusElement) statusElement.textContent = message;",
    "  }",
    "",
    "  function postToParent(type, payload = {}) {",
    "    if (!parentOrigin || window.parent === window) return false;",
    "    window.parent.postMessage({ type, version: CONFIG.protocol, ...payload }, parentOrigin);",
    "    return true;",
    "  }",
    "",
    "  function announceBridgeReady() {",
    "    if (window.parent === window) return;",
    "    const message = {",
    '      type: "mantou:bridge-ready",',
    "      version: CONFIG.protocol,",
    "      bridgeOrigin: location.origin,",
    "      protocol: CONFIG.protocol,",
    "      appVersion: CONFIG.appVersion,",
    "    };",
    "    const targets = parentOrigin ? [parentOrigin] : CONFIG.allowedOrigins;",
    "    for (const targetOrigin of targets) {",
    "      window.parent.postMessage(message, targetOrigin);",
    "    }",
    "  }",
    "",
    "  function postError(code, message) {",
    '    postToParent("mantou:error", {',
    "      token: session ? session.token : null,",
    "      projectId: session ? session.projectId : null,",
    "      code,",
    "      message,",
    "    });",
    "    setStatus(message);",
    "  }",
    "",
    "  function socketSend(payload) {",
    "    if (!socket || socket.readyState !== WebSocket.OPEN) {",
    '      postError("SOCKET_NOT_READY", "本地收图球连接尚未准备好。");',
    "      return false;",
    "    }",
    "    socket.send(JSON.stringify(payload));",
    "    return true;",
    "  }",
    "",
    "  function establishSocket() {",
    "    socket = new WebSocket(localSocketOrigin);",
    '    socket.binaryType = "arraybuffer";',
    "",
    '    socket.addEventListener("open", () => {',
    '      setStatus("收图球已就绪，等待网站配对。");',
    '      socketSend({ type: "bridge:hello", version: CONFIG.protocol });',
    "      announceBridgeReady();",
    "    });",
    "",
    '    socket.addEventListener("message", async (event) => {',
    '      if (typeof event.data === "string") {',
    "        handleSocketText(event.data);",
    "        return;",
    "      }",
    "",
    "      if (!pendingImage || !session) {",
    '        postError("UNEXPECTED_BINARY", "收到未标记的图片数据，已忽略。");',
    "        return;",
    "      }",
    "",
    "      const meta = pendingImage;",
    "      pendingImage = null;",
    "      const bytes = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();",
    "      if (bytes.byteLength !== meta.size) {",
    '        postError("IMAGE_SIZE_MISMATCH", "图片传输不完整，请重试。");',
    "        return;",
    "      }",
    "      if (!parentOrigin || window.parent === window) {",
    '        postError("PARENT_NOT_READY", "网站收图页面尚未准备好。");',
    "        return;",
    "      }",
    '      window.parent.postMessage({',
    '        type: "mantou:image",',
    "        version: CONFIG.protocol,",
    "        token: meta.token,",
    "        projectId: meta.projectId,",
    "        id: meta.id,",
    "        name: meta.name,",
    "        mime: meta.mime,",
    "        size: meta.size,",
    "        bytes,",
    "      }, parentOrigin, [bytes]);",
    '      setStatus("图片已交给当前项目保存。");',
    "    });",
    "",
    '    socket.addEventListener("close", () => {',
    '      postToParent("mantou:closed", {',
    "        token: session ? session.token : null,",
    "        projectId: session ? session.projectId : null,",
    "      });",
    '      setStatus("收图球连接已断开。");',
    "    });",
    "",
    '    socket.addEventListener("error", () => {',
    '      postError("SOCKET_ERROR", "无法连接本地收图球，请确认它正在运行。");',
    "    });",
    "  }",
    "",
    "  function handleSocketText(raw) {",
    "    let message;",
    "    try {",
    "      message = JSON.parse(raw);",
    "    } catch {",
    '      postError("INVALID_SOCKET_MESSAGE", "本地收图球返回了无法识别的数据。");',
    "      return;",
    "    }",
    "",
    '    if (message.type === "hello") return;',
    "",
    '    if (message.type === "paired") {',
    "      session = {",
    "        token: message.token,",
    "        projectId: message.projectId,",
    "        projectName: message.projectName,",
    "      };",
    '      postToParent("mantou:paired", {',
    "        token: session.token,",
    "        projectId: session.projectId,",
    "        projectName: session.projectName,",
    "        appVersion: message.appVersion || CONFIG.appVersion,",
    "      });",
    '      setStatus("已连接到「" + session.projectName + "」。");',
    "      return;",
    "    }",
    "",
    '    if (message.type === "image-meta") {',
    "      if (!session || message.token !== session.token || message.projectId !== session.projectId) {",
    '        postError("INVALID_IMAGE_SESSION", "图片会话校验失败，已忽略。");',
    "        return;",
    "      }",
    "      pendingImage = message;",
    "      return;",
    "    }",
    "",
    '    if (message.type === "unpaired") {',
    "      session = null;",
    '      postToParent("mantou:closed", {',
    "        token: message.token || null,",
    "        projectId: message.projectId || null,",
    "      });",
    '      setStatus("已解除与项目的连接。");',
    "      return;",
    "    }",
    "",
    '    if (message.type === "error") {',
    '      postError(message.code || "BRIDGE_ERROR", message.message || "本地收图球发生错误。");',
    "    }",
    "  }",
    "",
    '  window.addEventListener("message", (event) => {',
    "    const data = event.data;",
    '    if (!data || typeof data !== "object" || !allowedOrigins.has(event.origin)) return;',
    "",
    '    if (data.type === "mantou:pair") {',
    "      parentOrigin = event.origin;",
    "      if (data.parentOrigin && data.parentOrigin !== event.origin) {",
    '        postError("PARENT_ORIGIN_MISMATCH", "配对来源校验失败。");',
    "        return;",
    "      }",
    '      if (typeof data.token !== "string" || !data.token.startsWith("MS-")) {',
    '        postError("PAIR_TOKEN_REQUIRED", "需要有效的收图球配对码。");',
    "        return;",
    "      }",
    "      if (!safeString(data.projectId, 120) || !safeString(data.projectName, 120)) {",
    '        postError("PROJECT_REQUIRED", "请选择需要接收图片的项目后再配对。");',
    "        return;",
    "      }",
    "      socketSend({",
    '        type: "pair",',
    "        version: CONFIG.protocol,",
    "        token: data.token,",
    "        projectId: safeString(data.projectId, 120),",
    "        projectName: safeString(data.projectName, 120),",
    "        parentOrigin: event.origin,",
    "      });",
    "      return;",
    "    }",
    "",
    "    if (!session || data.token !== session.token || data.projectId !== session.projectId) return;",
    "",
    '    if (data.type === "mantou:ack") {',
    "      socketSend({",
    '        type: "ack",',
    "        version: CONFIG.protocol,",
    "        token: session.token,",
    "        projectId: session.projectId,",
    "        id: safeString(data.id, 160),",
    '        status: data.status === "saved" ? "saved" : "rejected",',
    "        message: safeString(data.message, 240),",
    "      });",
    "      return;",
    "    }",
    "",
    '    if (data.type === "mantou:disconnect") {',
    "      socketSend({",
    '        type: "disconnect",',
    "        version: CONFIG.protocol,",
    "        token: session.token,",
    "        projectId: session.projectId,",
    "      });",
    "    }",
    "  });",
    "",
    "  establishSocket();",
    "})();",
  ].join("\n");
}

/**
 * A loopback-only bridge between the native receiver ball and a user-approved
 * Mantou Sesame web page. Images are never uploaded to a remote server here;
 * the page receives a File and persists it in its own local storage.
 */
export class LocalBridgeServer extends EventEmitter {
  constructor({
    port = BRIDGE_PORT,
    allowedParentOrigins = DEFAULT_ALLOWED_PARENT_ORIGINS,
    appVersion = "0.0.0",
  } = {}) {
    super();
    this.port = port;
    this.allowedParentOrigins = new Set(allowedParentOrigins);
    this.appVersion = safeText(appVersion, 32) || "0.0.0";
    this.pairToken = randomPairToken();
    this.server = null;
    this.socketServer = null;
    this.activeBridgeSocket = null;
    this.pairedSession = null;
    this.pendingPairToken = null;
    this.pendingTransfers = new Map();
    this.transferTail = Promise.resolve();
  }

  getStatus() {
    return {
      port: this.port,
      pairingCode: this.pairToken,
      paired: Boolean(this.pairedSession),
      connected: Boolean(
        this.activeBridgeSocket && this.activeBridgeSocket.readyState === WebSocket.OPEN,
      ),
      projectId: this.pairedSession ? this.pairedSession.projectId : null,
      projectName: this.pairedSession ? this.pairedSession.projectName : null,
      maxImageBytes: MAX_IMAGE_BYTES,
      protocol: BRIDGE_PROTOCOL_VERSION,
      appVersion: this.appVersion,
    };
  }

  // A user-initiated mantousesame:// link can carry a short-lived pairing
  // token from the approved website. Queue it during a project switch so the
  // old page can explicitly disconnect before the new page connects.
  setPairingToken(token) {
    const nextToken = safeText(token, 80).toUpperCase();
    if (!isPairToken(nextToken)) return false;
    if (
      this.pairedSession &&
      this.activeBridgeSocket &&
      this.activeBridgeSocket.readyState === WebSocket.OPEN
    ) {
      this.pendingPairToken = nextToken;
      return true;
    }
    this.pairedSession = null;
    this.activeBridgeSocket = null;
    this.pendingPairToken = null;
    this.pairToken = nextToken;
    this.#emitStatus();
    return true;
  }

  async start() {
    if (this.server) return this.getStatus();

    this.server = createServer((request, response) => this.#handleHttp(request, response));
    this.socketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024,
    });
    this.socketServer.on("connection", (socket) => this.#handleSocket(socket));
    this.server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, "127.0.0.1");
    });

    this.#emitStatus();
    return this.getStatus();
  }

  async stop() {
    for (const transfer of this.pendingTransfers.values()) {
      clearTimeout(transfer.timeout);
      clearInterval(transfer.retryTimer);
      transfer.reject(new Error("收图球已关闭，图片未送达。"));
    }
    this.pendingTransfers.clear();

    if (this.socketServer) {
      for (const socket of this.socketServer.clients) socket.terminate();
      this.socketServer.close();
      this.socketServer = null;
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  async publishDroppedFile(file) {
    const job = this.transferTail.then(() => this.#publishDroppedFile(file));
    // A rejected transfer should not permanently block the following drop.
    this.transferTail = job.catch(() => undefined);
    return job;
  }

  #emitStatus() {
    this.emit("status", this.getStatus());
  }

  #handleHttp(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1:" + this.port);
    const frameAncestors = [...this.allowedParentOrigins].join(" ");
    const requestOrigin = safeText(request.headers.origin, 256);
    const originAllowed = this.allowedParentOrigins.has(requestOrigin);
    const commonHeaders = {
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      ...(originAllowed ? {
        "Access-Control-Allow-Origin": requestOrigin,
        "Vary": "Origin",
      } : {}),
    };

    if (request.method === "OPTIONS" && originAllowed) {
      response.writeHead(204, {
        ...commonHeaders,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/bridge") {
      response.writeHead(200, {
        ...commonHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:" + this.port + "; frame-ancestors " + frameAncestors + "; base-uri 'none'; form-action 'none'",
      });
      response.end(makeBridgeHtml());
      return;
    }

    if (request.method === "GET" && url.pathname === "/bridge.js") {
      response.writeHead(200, {
        ...commonHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
      });
      response.end(makeBridgeScript({
        port: this.port,
        allowedOrigins: [...this.allowedParentOrigins],
        appVersion: this.appVersion,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/bridge.css") {
      response.writeHead(200, {
        ...commonHeaders,
        "Content-Type": "text/css; charset=utf-8",
      });
      response.end(makeBridgeCss());
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, {
        ...commonHeaders,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({
        service: "mantou-sesame-receiver-bridge",
        protocol: BRIDGE_PROTOCOL_VERSION,
        paired: Boolean(this.pairedSession),
      }));
      return;
    }

    response.writeHead(404, {
      ...commonHeaders,
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ error: "not_found" }));
  }

  #handleUpgrade(request, socket, head) {
    const url = new URL(request.url || "/", "http://127.0.0.1:" + this.port);
    const localOrigin = "http://127.0.0.1:" + this.port;
    const alternateLocalOrigin = "http://localhost:" + this.port;
    if (
      url.pathname !== "/socket" ||
      (request.headers.origin !== localOrigin && request.headers.origin !== alternateLocalOrigin)
    ) {
      socket.destroy();
      return;
    }

    this.socketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.socketServer.emit("connection", webSocket, request);
    });
  }

  #handleSocket(socket) {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        sendJson(socket, errorPayload("BINARY_NOT_ACCEPTED", "桥接页面不能向收图球发送二进制数据。"));
        return;
      }
      this.#handleSocketMessage(socket, raw.toString());
    });

    socket.on("close", () => {
      if (this.activeBridgeSocket === socket) {
        this.activeBridgeSocket = null;
        this.#rejectPendingTransfers("网站收图桥已断开，图片尚未保存。");
        this.pairedSession = null;
        this.pairToken = this.pendingPairToken || randomPairToken();
        this.pendingPairToken = null;
        this.#emitStatus();
      }
    });

    socket.on("error", () => {
      // The close handler owns cleanup; suppress noisy socket errors here.
    });
  }

  #handleSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(socket, errorPayload("INVALID_MESSAGE", "无法识别本地桥接消息。"));
      return;
    }

    if (!message || typeof message !== "object") {
      sendJson(socket, errorPayload("INVALID_MESSAGE", "本地桥接消息格式不正确。"));
      return;
    }

    if (message.type === "bridge:hello") {
      sendJson(socket, { type: "hello", version: BRIDGE_PROTOCOL_VERSION, appVersion: this.appVersion });
      return;
    }

    if (message.type === "pair") {
      this.#pairSocket(socket, message);
      return;
    }

    if (!this.#isAuthorizedSocket(socket, message)) {
      sendJson(socket, errorPayload("UNAUTHORIZED", "当前桥接页面未完成配对。"));
      return;
    }

    if (message.type === "ack") {
      const transfer = this.pendingTransfers.get(message.id);
      if (!transfer) return;
      clearTimeout(transfer.timeout);
      clearInterval(transfer.retryTimer);
      this.pendingTransfers.delete(message.id);
      if (message.status === "saved") {
        transfer.resolve({ id: message.id, status: "saved" });
      } else {
        transfer.reject(new Error(safeText(message.message, 240) || "网站拒绝保存这张图片。"));
      }
      return;
    }

    if (message.type === "disconnect") {
      this.#unpair("网站已主动断开收图球。", socket);
      return;
    }

    sendJson(socket, errorPayload("UNKNOWN_MESSAGE", "未知的桥接命令。"));
  }

  #pairSocket(socket, message) {
    const token = safeText(message.token, 80);
    const projectId = safeText(message.projectId, 120);
    const projectName = safeText(message.projectName, 120);
    const parentOrigin = safeText(message.parentOrigin, 240);

    if (!tokensMatch(token, this.pairToken)) {
      sendJson(socket, errorPayload("INVALID_PAIR_TOKEN", "配对码不正确或已失效。"));
      return;
    }
    if (!this.allowedParentOrigins.has(parentOrigin)) {
      sendJson(socket, errorPayload("PARENT_ORIGIN_DENIED", "此网站未获准连接收图球。"));
      return;
    }
    if (!projectId || !projectName) {
      sendJson(socket, errorPayload("PROJECT_REQUIRED", "必须指定接收图片的项目。"));
      return;
    }

    if (
      this.pairedSession &&
      (this.pairedSession.parentOrigin !== parentOrigin || this.pairedSession.projectId !== projectId)
    ) {
      sendJson(socket, errorPayload("ALREADY_PAIRED", "收图球已连接到另一个项目，请先在网站中断开。"));
      return;
    }

    if (this.activeBridgeSocket && this.activeBridgeSocket !== socket) {
      this.activeBridgeSocket.close(4000, "A newer bridge session replaced this page.");
    }

    this.pairedSession = { token, projectId, projectName, parentOrigin };
    this.activeBridgeSocket = socket;
    socket.pairedSession = this.pairedSession;
    sendJson(socket, {
      type: "paired",
      version: BRIDGE_PROTOCOL_VERSION,
      token,
      projectId,
      projectName,
      appVersion: this.appVersion,
    });
    this.#emitStatus();
  }

  #isAuthorizedSocket(socket, message) {
    return Boolean(
      this.pairedSession &&
      this.activeBridgeSocket === socket &&
      socket.pairedSession === this.pairedSession &&
      tokensMatch(message.token, this.pairedSession.token) &&
      message.projectId === this.pairedSession.projectId,
    );
  }

  #unpair(reason, socket) {
    const previous = this.pairedSession;
    this.#rejectPendingTransfers(reason);
    this.pairedSession = null;
    this.activeBridgeSocket = null;
    this.pairToken = this.pendingPairToken || randomPairToken();
    this.pendingPairToken = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendJson(socket, {
        type: "unpaired",
        version: BRIDGE_PROTOCOL_VERSION,
        token: previous ? previous.token : null,
        projectId: previous ? previous.projectId : null,
      });
    }
    this.#emitStatus();
  }

  #rejectPendingTransfers(message) {
    for (const transfer of this.pendingTransfers.values()) {
      clearTimeout(transfer.timeout);
      clearInterval(transfer.retryTimer);
      transfer.reject(new Error(message));
    }
    this.pendingTransfers.clear();
  }

  async #publishDroppedFile(file) {
    const normalized = await this.#validateImageFile(file);
    const socket = this.activeBridgeSocket;
    const session = this.pairedSession;
    if (!session || !socket || socket.readyState !== WebSocket.OPEN) {
      const error = new Error("收图球尚未与网站项目连接。请先在「我的创作」中点击连接 Windows 收图球。");
      error.code = "UNPAIRED";
      throw error;
    }

    const bytes = normalized.bytes || await readFile(normalized.realPath);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片超过 50 MiB，未上传。");
    }

    const id = randomTransferId();
    const meta = {
      type: "image-meta",
      version: BRIDGE_PROTOCOL_VERSION,
      token: session.token,
      projectId: session.projectId,
      id,
      name: normalized.name,
      mime: normalized.mime,
      size: bytes.byteLength,
    };

    return new Promise((resolve, reject) => {
      const sendTransfer = () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(meta));
        socket.send(bytes, { binary: true });
      };
      const timeout = setTimeout(() => {
        const transfer = this.pendingTransfers.get(id);
        if (transfer) clearInterval(transfer.retryTimer);
        this.pendingTransfers.delete(id);
        reject(new Error("网站没有确认保存图片，请检查收图球连接后重试。"));
      }, 45_000);

      const retryTimer = setInterval(() => {
        if (!this.pendingTransfers.has(id)) return;
        try {
          sendTransfer();
        } catch {
          // The socket close handler or overall timeout will provide the final error.
        }
      }, 8_000);

      this.pendingTransfers.set(id, { resolve, reject, timeout, retryTimer });
      try {
        sendTransfer();
      } catch (error) {
        clearTimeout(timeout);
        clearInterval(retryTimer);
        this.pendingTransfers.delete(id);
        reject(error);
      }
    });
  }

  async #validateImageFile(file) {
    const filePath = safeText(file?.path, 2048);
    if (!filePath) {
      let bytes;
      if (file?.bytes instanceof ArrayBuffer) {
        bytes = Buffer.from(file.bytes);
      } else if (ArrayBuffer.isView(file?.bytes)) {
        bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
      }
      if (!bytes) throw new Error("网页没有提供可读取的图片文件。请先复制图片再粘贴，或下载后拖入。");
      if (bytes.byteLength <= 0) throw new Error("这张图片为空，未上传。");
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 50 MiB，未上传。");

      const name = safeFileName(file?.name || "网页图片");
      const extensionMime = ACCEPTED_IMAGE_TYPES.get(path.extname(name).toLowerCase());
      const declaredMime = safeText(file?.type || file?.mime, 80).toLowerCase();
      const mime = extensionMime || (ACCEPTED_IMAGE_MIME_TYPES.has(declaredMime) ? declaredMime : "");
      if (!mime) {
        throw new Error("仅支持 JPG、PNG、WebP、GIF、HEIC、SVG、TIFF、AVIF 或 BMP 图片。");
      }
      return { bytes, name, mime };
    }

    const realPath = await realpath(filePath);
    const fileStats = await stat(realPath);
    if (!fileStats.isFile()) throw new Error("只能拖入本地图片文件。");
    if (fileStats.size <= 0) throw new Error("这张图片为空，未上传。");
    if (fileStats.size > MAX_IMAGE_BYTES) throw new Error("图片超过 50 MiB，未上传。");

    const extension = path.extname(realPath).toLowerCase();
    const mime = ACCEPTED_IMAGE_TYPES.get(extension);
    if (!mime) {
      throw new Error("仅支持 JPG、PNG、WebP、GIF、HEIC、SVG、TIFF、AVIF 或 BMP 图片。");
    }

    return {
      realPath,
      name: safeFileName(file?.name || path.basename(realPath)),
      mime,
    };
  }
}
