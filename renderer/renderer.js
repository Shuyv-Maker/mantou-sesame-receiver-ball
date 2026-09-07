import { mountOrb } from "./orb.js";

const ball = document.getElementById("receiver-ball");
const stateLabel = document.getElementById("receiver-state");
const copyLabel = document.getElementById("receiver-copy");
const liveLabel = document.getElementById("receiver-live");

let status = null;
let dragStart = null;
let moved = false;
let feedbackTimer = null;
let transferring = false;
const badge = document.querySelector('.receiver-badge');
let dragHeartbeat = null;
mountOrb(document.getElementById("receiver-orb"), ball);

function setText(state, copy, announcement) {
  stateLabel.textContent = state;
  copyLabel.textContent = copy;
  ball.title = [state, copy, "拖入图片 · 右键菜单 · 双击连接说明"].join("\n");
  ball.setAttribute("aria-label", announcement || state + "：" + copy);
  if (announcement) liveLabel.textContent = announcement;
}

function renderStatus(nextStatus) {
  status = nextStatus;
  if (transferring || feedbackTimer) return;
  ball.classList.remove("is-unpaired", "is-paired", "is-error", "is-working", "is-success");

  if (!status) {
    setText("启动中", "请稍候", "收图球正在启动。");
    return;
  }

  if (status.paired && status.connected) {
    ball.classList.add("is-paired");
    setText("已连接", trimProjectName(status.projectName), "收图球已连接到项目：" + status.projectName);
    return;
  }

  if (status.paired) {
    setText("待重连", trimProjectName(status.projectName), "收图球正在等待网站重新连接。");
    return;
  }

  setText("待连接", "网站自动连接", "收图球尚未连接网站项目。请在网站中点击连接 Windows 收图球。");
}

function trimProjectName(name) {
  if (!name) return "项目";
  return name.length > 7 ? name.slice(0, 7) + "…" : name;
}

function showWorking(message) {
  clearTimeout(feedbackTimer);
  feedbackTimer = null;
  ball.classList.remove("is-error", "is-success");
  ball.classList.add("is-working");
  setText("收图中", message || "请稍候", message || "图片正在传送。");
}

function showError(message) {
  ball.classList.remove("is-working", "is-success");
  ball.classList.add("is-error");
  const copy = message.includes("尚未与网站")
    ? ["尚未连接", "先点网站连接"]
    : message.includes("没有检测到")
      ? ["没有图片", "请重新拖入"]
    : message.includes("没有确认")
      ? ["网站未回应", "保持网页开启"]
      : message.includes("超过 50")
        ? ["图片过大", "上限 50 MB"]
        : message.includes("网页没有提供")
          ? ["无法读取", "复制后粘贴"]
          : ["未送达", "右键看原因"];
  setText(copy[0], copy[1], message);
  resetFeedbackAfter(4200);
}

function resetFeedbackAfter(delay) {
  clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    feedbackTimer = null;
    renderStatus(status);
  }, delay);
}

async function ingest(files) {
  if (transferring) return;
  const candidates = Array.from(files || []);
  if (candidates.length === 0) {
    showError("没有检测到可上传的图片。请重新拖入本地图片文件。");
    return;
  }
  ball.classList.remove("is-dragover");
  transferring = true;
  badge.textContent = '0';
  badge.classList.add('has-count');
  let saved = 0;
  showWorking(candidates.length > 1 ? "正在传送多张" : "正在传送");
  try {
    const results = [];
    for (const file of candidates) {
      let fileResults;
      try { fileResults = await window.mantouReceiver.ingestFile(file); }
      catch (error) { fileResults = [{ ok: false, message: String(error.message || error) }]; }
      results.push(...fileResults);
      saved += fileResults.filter(result => result.ok).length;
      badge.textContent = String(saved);
    }
    const failed = results.find((result) => !result.ok);
    if (failed) {
      showError(`本批已收录 ${saved}/${candidates.length} 张。` + (failed.message || "图片没有保存成功。"));
      return;
    }
    ball.classList.remove("is-working");
    ball.classList.add("is-success");
    setText("已收录", `本批 ${saved} 张`, `本批 ${saved} 张图片已保存到当前项目。`);
    resetFeedbackAfter(1600);
  } catch (error) {
    showError(error instanceof Error ? error.message : "图片传送失败。");
  } finally {
    transferring = false;
  }
}

ball.addEventListener("dragenter", (event) => {
  event.preventDefault();
  ball.classList.add("is-dragover");
});

ball.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

ball.addEventListener("dragleave", (event) => {
  if (!ball.contains(event.relatedTarget)) ball.classList.remove("is-dragover");
});

ball.addEventListener("drop", (event) => {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (files?.length) {
    void ingest(files);
    return;
  }
  ball.classList.remove("is-dragover");
  showError("网页没有提供可读取的图片文件。请先复制图片再粘贴，或下载后拖入。");
});

window.addEventListener("paste", (event) => {
  const files = event.clipboardData?.files;
  if (files?.length) void ingest(files);
});

ball.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  stopDrag();
  dragStart = { id: event.pointerId };
  moved = false;
  ball.setPointerCapture?.(event.pointerId);
  window.mantouReceiver.drag('start', { x: event.clientX, y: event.clientY });
  dragHeartbeat = setInterval(() => window.mantouReceiver.drag('move'), 300);
});

ball.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  if (!(event.buttons & 1)) { stopDrag(); return; }
  if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) moved = true;
  window.mantouReceiver.drag('move');
});

function stopDrag() {
  const id = dragStart?.id;
  dragStart = null;
  clearInterval(dragHeartbeat);
  dragHeartbeat = null;
  window.mantouReceiver.drag('end');
  if (id !== undefined && ball.hasPointerCapture(id)) ball.releasePointerCapture(id);
}
window.addEventListener('pointerup', stopDrag);
ball.addEventListener('pointercancel', stopDrag);
ball.addEventListener('lostpointercapture', stopDrag);
window.addEventListener('blur', stopDrag);
window.addEventListener('pagehide', stopDrag);
window.addEventListener('dragend', () => { stopDrag(); ball.classList.remove('is-dragover'); });

ball.addEventListener("dblclick", () => {
  if (!moved) void window.mantouReceiver.showPairing();
});

ball.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void window.mantouReceiver.showPairing();
  }
});

ball.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  stopDrag();
  void window.mantouReceiver.showContextMenu();
});

window.mantouReceiver.onStatus(renderStatus);
window.mantouReceiver.getStatus().then(renderStatus);
