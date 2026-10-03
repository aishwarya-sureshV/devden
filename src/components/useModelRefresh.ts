import { useEffect, useRef } from "react";

// All model selectors refresh while mounted; focusing the app and finishing
// a harness update also refresh them without reloading a draft message.
export function useModelRefresh(refresh: () => void, enabled = true) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState !== "hidden") latest.current();
    };
    const timer = window.setInterval(run, 5 * 60_000);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("devden:models-updated", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("devden:models-updated", run);
    };
  }, [enabled]);
}
