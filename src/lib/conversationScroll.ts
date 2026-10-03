/** Reserve a viewport for the newest prompt; consume the space as its reply grows. */
export function syncConversationScroll(
  el: HTMLElement,
  follow: { current: boolean },
  lastPrompt: { current: string },
) {
  if (!el.clientHeight) return;
  const column = el.querySelector<HTMLElement>(".conversation__column");
  const prompt = el.querySelector<HTMLElement>("[data-current-prompt]");
  const spacer = el.querySelector<HTMLElement>(".conversation__spacer");
  const key = prompt?.dataset.currentPrompt ?? "";
  const newPrompt = key !== lastPrompt.current;
  lastPrompt.current = key;
  if (newPrompt && key) follow.current = true;

  let promptTop = 0;
  if (column && prompt && spacer) {
    const inset = parseFloat(getComputedStyle(column).paddingTop) || 0;
    const rect = prompt.getBoundingClientRect();
    promptTop = el.scrollTop + rect.top - el.getBoundingClientRect().top - inset;
    const contentHeight = column.getBoundingClientRect().bottom - rect.top
      - spacer.getBoundingClientRect().height;
    const height = Math.max(0, el.clientHeight - inset - contentHeight);
    if (spacer.style.height !== `${height}px`) spacer.style.height = `${height}px`;
  }
  if (!follow.current) return;
  const target = newPrompt && key ? Math.max(0, promptTop)
    : Math.max(0, el.scrollHeight - el.clientHeight);
  if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
}
