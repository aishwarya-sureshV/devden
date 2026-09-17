/**
 * The lease sweep's verdict for one session: reap the agent, or spare it.
 *
 * A lapsed lease does not prove the page is gone — a background tab the
 * browser froze, or a sleeping machine, stops heartbeating while the tab is
 * still open. Reaping on lapse alone killed sessions the instant their turn
 * completed (a working agent was spared by the grace below; a completed one
 * was not), so every live agent — working or idle — gets the same bounded
 * grace before the sweep stops it. A page that really is closed is still
 * reaped, just within the grace window instead of on the first sweep after.
 */

/** A lease is healthy while the page heartbeated within this window. */
export const LEASE_TIMEOUT_MS = 5 * 60_000;

/** How long a live agent may outlive its page's heartbeat: long enough to
 *  cover a frozen tab or a sleeping laptop, short enough that an abandoned
 *  or wedged agent is not immortal. */
export const LEASE_GRACE_MS = 60 * 60_000;

const DEAD_STATUSES = new Set(["stopped", "error"]);

/**
 * @param {object} args
 * @param {number} args.lastHeartbeat - when the page last renewed this lease
 * @param {string|undefined} args.status - the agent's status; undefined if
 *   there is no live process for the key
 * @param {number} args.now
 * @param {number|undefined} args.deadline - the grace expiry remembered from
 *   the previous sweep
 * @param {number} [args.timeoutMs=LEASE_TIMEOUT_MS]
 * @param {number} [args.graceMs=LEASE_GRACE_MS]
 * @returns {{ reap: boolean, deadline: number|undefined }} `deadline` is the
 *   grace expiry to remember for the next sweep, or undefined to clear it.
 */
export function leaseVerdict({
 lastHeartbeat,
 status,
 now,
 deadline,
 timeoutMs = LEASE_TIMEOUT_MS,
 graceMs = LEASE_GRACE_MS,
}) {
 if (now - lastHeartbeat <= timeoutMs)
  return { reap: false, deadline: undefined };
 if (status === undefined || DEAD_STATUSES.has(status)) {
  return { reap: true, deadline: undefined };
 }
 const expires = deadline ?? now + graceMs;
 if (now < expires) return { reap: false, deadline: expires };
 return { reap: true, deadline: undefined };
}
