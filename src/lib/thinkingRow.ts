/** Live assistant text may sit unchanged until the next tool/thinking
 *  block starts. After this pause, show the thinking row even if `live`
 *  is still true — otherwise the transcript looks idle for the whole gap. */
export const LIVE_TEXT_STALL_MS = 400;

export function shouldShowThinkingRow({
  streaming,
  runningShell = false,
  subagentRunning = false,
  compacting = false,
  showingLiveText = false,
  liveTextStalled = false,
}: {
  streaming: boolean;
  runningShell?: boolean;
  subagentRunning?: boolean;
  compacting?: boolean;
  showingLiveText?: boolean;
  liveTextStalled?: boolean;
}): boolean {
  if (!streaming || runningShell || subagentRunning || compacting) return false;
  return !showingLiveText || liveTextStalled;
}
