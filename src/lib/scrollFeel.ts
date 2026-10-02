// App-wide feel: any scroll container fades its edges while there's more
// content that way.
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
}
