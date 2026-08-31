import assert from "node:assert/strict";
import { LocalBridgeServer } from "../bridge-server.mjs";
import { WebSocket } from "ws";

const port = 49732;
const localOrigin = "http://127.0.0.1:" + port;
const parentOrigin = "https://mantou-sesame-knowledge-studio.qishuyv.chatgpt.site";
const bridge = new LocalBridgeServer({ port, allowedParentOrigins: [parentOrigin], appVersion: "0.1.1" });
let socket;

function waitForMessage(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("等待桥接消息超时。"));
    }, timeoutMs);
    const onMessage = (raw, isBinary) => {
      const value = isBinary ? raw : JSON.parse(raw.toString());
      if (!predicate(value, isBinary)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(value);
    };
    socket.on("message", onMessage);
  });
}

async function waitForCondition(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待桥接状态更新超时。");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  await bridge.start();

  const preflight = await fetch(localOrigin + "/bridge", {
    method: "OPTIONS",
    headers: {
      Origin: parentOrigin,
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

  const bridgeScript = await fetch(localOrigin + "/bridge.js", {
    headers: { Origin: parentOrigin },
  }).then((response) => response.text());
  assert.doesNotThrow(() => new Function(bridgeScript));

  socket = new WebSocket(localOrigin.replace("http:", "ws:") + "/socket", {
    origin: localOrigin,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const status = bridge.getStatus();
  socket.send(JSON.stringify({
    type: "pair",
    version: 1,
    token: status.pairingCode,
    projectId: "project_test",
    projectName: "传输测试项目",
    parentOrigin,
  }));
  await waitForMessage((message) => message.type === "paired");

  let meta;
  let binaryDeliveries = 0;
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) {
      const message = JSON.parse(raw.toString());
      if (message.type === "image-meta") meta = message;
      return;
    }
    binaryDeliveries += 1;
    if (binaryDeliveries < 2 || !meta) return;
    socket.send(JSON.stringify({
      type: "ack",
      version: 1,
      token: status.pairingCode,
      projectId: "project_test",
      id: meta.id,
      status: "saved",
    }));
  });

  const pngBytes = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  const result = await bridge.publishDroppedFile({
    name: "网页拖入图片.png",
    type: "image/png",
    size: pngBytes.byteLength,
    bytes: pngBytes,
  });

  assert.equal(result.status, "saved");
  assert.ok(binaryDeliveries >= 2, "丢失首次回执后应自动重发图片");

  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
  await waitForCondition(() => !bridge.getStatus().paired);
  assert.equal(bridge.getStatus().paired, false, "网页断开后必须清理旧配对会话");

  const reconnectToken = "MS-" + "A".repeat(24);
  assert.equal(bridge.setPairingToken(reconnectToken), true);
  socket = new WebSocket(localOrigin.replace("http:", "ws:") + "/socket", {
    origin: localOrigin,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "pair",
    version: 1,
    token: reconnectToken,
    projectId: "project_reconnected",
    projectName: "重连测试项目",
    parentOrigin,
  }));
  const reconnected = await waitForMessage((message) => message.type === "paired");
  assert.equal(reconnected.projectId, "project_reconnected");
  assert.equal(bridge.getStatus().connected, true);

  process.stdout.write("桥接测试通过：虚拟图片、私网预检、重发、保存回执和断线重连均正常。\n");
} finally {
  socket?.close();
  await bridge.stop();
}
