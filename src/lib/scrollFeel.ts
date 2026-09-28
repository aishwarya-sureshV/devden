// App-wide feel: any scroll container fades its edges while there's more
// content that way, and a soft glow trails the pointer with easing.
const EDGE = 4;

function updateFade(el: HTMLElement) {
  if (el instanceof HTMLTextAreaElement) return;
  const top = el.scrollTop > EDGE;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - EDGE;
  const next = [top && "top", bottom && "bottom"].filter(Boolean).join(" ");
  if (next) el.dataset.fade = next;
  else delete el.dataset.fade;
}

export function installScrollFeel() {
  // scroll doesn't bubble; capture sees every container's scroll
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof HTMLElement) updateFade(e.target);
    },
    { capture: true, passive: true },
  );

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const glow = document.createElement("div");
  glow.className = "cursor-glow";
  document.body.appendChild(glow);
  let x = 0, y = 0, tx = 0, ty = 0, raf = 0;
  const tick = () => {
    x += (tx - x) * 0.12; // lower = lazier, more soothing trail
    y += (ty - y) * 0.12;
    glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(tick) : 0;
  };
  addEventListener("pointermove", (e) => {
    if (!glow.classList.contains("is-on")) (x = e.clientX), (y = e.clientY);
    tx = e.clientX;
    ty = e.clientY;
    glow.classList.add("is-on");
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => glow.classList.remove("is-on"));
}
