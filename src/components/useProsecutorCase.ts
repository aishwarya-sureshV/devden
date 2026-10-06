import { useEffect, useState } from "react";
import { api, subscribeEvents, type ProsecutorState } from "../lib/api";
import { liftedEffort } from "../lib/prosecutorEffort";

/** The server-side prosecutor case for this session (null outside prosecutor mode). */
/** `sessionPath` (stable across refresh) reattaches a case saved before a restart. */
export function useProsecutorCase(sessionKey: string, active: boolean, sessionPath?: string) {
  const [caseState, setCaseState] = useState<ProsecutorState | null>(null);
  useEffect(() => {
    setCaseState(null);
    if (!active) return;
    // A prosecutor_state push that arrives while the initial GET is in flight
    // is newer than that GET. Applying the late response would hide the case.
    let open = true;
    void api
      .prosecutorState(sessionKey, sessionPath)
      .then((next) => {
        if (open) setCaseState(next);
      })
      .catch(() => {});
    const unsubscribe = subscribeEvents((event) => {
      if (event.type === "prosecutor_state" && event.sessionKey === sessionKey) {
        open = false;
        setCaseState(event as unknown as ProsecutorState);
      }
    });
    return () => {
      open = false;
      unsubscribe();
    };
  }, [sessionKey, active, sessionPath]);
  return caseState;
}

/** Keeps the executor at the round-1 floor: a lower effort is lifted to it. */
export function useEffortFloor(
  floor: string | null,
  levels: string[],
  effort: string,
  setEffort: (level: string) => void,
) {
  const lift = liftedEffort(levels, effort, floor);
  useEffect(() => {
    if (lift) setEffort(lift);
    // setEffort is a fresh closure each render; `lift` is the trigger.
  }, [lift]);
}
