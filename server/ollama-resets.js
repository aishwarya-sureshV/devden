/**
 * Ollama's reset clock, computed from the two schedules it keeps.
 *
 * `ollama.com/api/usage` reports usage fractions and no reset time at all --
 * no field, no rate-limit headers, and the page that does show it wants a
 * browser session we have no way to hold. So the clock is derived instead:
 *
 *   - the session window rolls every 5 hours, and
 *   - the week resets Monday 04:30 local.
 *
 * The 5 hour grid needs one phase anchor, and SESSION_ANCHOR_MS is it: the
 * settings page read "Resets in 43 minutes" when the screenshot was taken at
 * 2026-09-11 21:46:41, putting that reset at 22:29:41 local. Every later reset
 * is that instant plus a multiple of the window, so one anchor is enough
 * indefinitely and there is no state to persist.
 *
 * Because both are pure functions of `now`, nothing here fetches or stores
 * anything. If the 5 hour grid ever drifts, re-anchor the constant.
 */

const SESSION_WINDOW_MS = 5 * 3_600_000;
/** 2026-09-11 22:29:41 local -- the settings page's "Resets in 43 minutes". */
const SESSION_ANCHOR_MS = new Date(2026, 8, 11, 22, 29, 41).getTime();
const WEEKLY_RESET_DAY = 1; // Monday
const WEEKLY_RESET_HOUR = 4;
const WEEKLY_RESET_MINUTE = 30;

/** The next point on the 5 hour grid strictly after `now`. */
export function sessionResetAt(now = Date.now()) {
 const steps = Math.ceil((now - SESSION_ANCHOR_MS) / SESSION_WINDOW_MS);
 const at = SESSION_ANCHOR_MS + steps * SESSION_WINDOW_MS;
 return at > now ? at : at + SESSION_WINDOW_MS;
}

/** The next Monday 04:30 local strictly after `now`. */
export function weeklyResetAt(now = Date.now()) {
 const next = new Date(now);
 next.setHours(WEEKLY_RESET_HOUR, WEEKLY_RESET_MINUTE, 0, 0);
 // setHours leaves today in place even when 04:30 has already gone, so step
 // forward a day at a time until both the weekday and the clock line up.
 while (next.getDay() !== WEEKLY_RESET_DAY || next.getTime() <= now) {
  next.setDate(next.getDate() + 1);
 }
 return next.getTime();
}

/** Both reset instants, in the shape the usage chip expects. */
export function ollamaResets(now = Date.now()) {
 return { session: sessionResetAt(now), weekly: weeklyResetAt(now) };
}
