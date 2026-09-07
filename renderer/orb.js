// thinking-orbs 0.3.1, MIT © Jakub Antalik. See THIRD_PARTY_NOTICES.md.
import { MODE_DRAWS, MODE_FRAMES, paintFrame, resolvePreset } from "../node_modules/thinking-orbs/dist/engine.es.js";

export function mountOrb(canvas, ball) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0;
  let lastFrame = -Infinity;
  let elapsed = 0;
  let previous = 0;
  let state = "";
  let preset;
  let scatter = 0;
  function paint(now) {
    const next = ball.classList.contains("is-error") ? "shaping"
      : ball.classList.contains("is-working") ? "working"
      : ball.classList.contains("is-dragover") ? "listening"
      : ball.classList.contains("is-success") ? "breathing"
      : ball.classList.contains("is-paired") ? "searching" : "connecting";
    if (state !== next) { state = next; preset = resolvePreset(state, 64); }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(64 * dpr)) canvas.width = canvas.height = Math.round(64 * dpr);
    if (previous) elapsed += Math.min(now - previous, 80) / 1000;
    previous = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 64, 64);
    const time = reduced.matches || state === "shaping" ? 0.6 : elapsed * preset.speed * 0.5;
    const targetScatter = ball.classList.contains('is-dragover') || ball.classList.contains('is-working') ? 1 : 0;
    scatter += (targetScatter - scatter) * (reduced.matches ? 1 : 0.18);
    if (scatter > 0.01) {
      const base = resolvePreset('searching', 64);
      const frame = MODE_FRAMES[base.mode](64, time, base.opts);
      frame.dots.forEach((dot, i) => {
        const angle = i * 2.39996 + time * 0.8;
        const radius = 25 * Math.sqrt(((i * 73) % 211) / 211);
        dot.x += (32 + Math.cos(angle) * radius - dot.x) * scatter;
        dot.y += (32 + Math.sin(angle) * radius - dot.y) * scatter;
      });
      paintFrame(ctx, frame, true);
    } else MODE_DRAWS[preset.mode](ctx, 64, time, true, preset.opts);
    canvas.dataset.scatter = String(scatter);
    canvas.dataset.state = state;
  }
  function tick(now) {
    if (now - lastFrame >= 1000 / 30) { paint(now); lastFrame = now; }
    raf = requestAnimationFrame(tick);
  }
  function restart() {
    cancelAnimationFrame(raf);
    previous = 0;
    paint(performance.now());
    if (!reduced.matches && !document.hidden) raf = requestAnimationFrame(tick);
  }
  const observer = new MutationObserver(() => paint(performance.now()));
  observer.observe(ball, { attributes: true, attributeFilter: ["class"] });
  reduced.addEventListener("change", restart);
  document.addEventListener("visibilitychange", restart);
  window.addEventListener("resize", restart);
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf); observer.disconnect();
    reduced.removeEventListener("change", restart);
    document.removeEventListener("visibilitychange", restart);
    window.removeEventListener("resize", restart);
  }, { once: true });
  restart();
}
