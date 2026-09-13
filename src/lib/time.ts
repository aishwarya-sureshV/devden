/** Compact relative time labels for sidebar/session lists. */

export function formatRelativeTime(ms: number, now = Date.now()): string {
 const minutes = Math.round((now - ms) / 60_000);
 if (minutes < 1) return "now";
 if (minutes < 60) return `${minutes}m`;
 const hours = Math.round(minutes / 60);
 if (hours < 24) return `${hours}h`;
 return `${Math.round(hours / 24)}d`;
}

/**
 * A countdown to a future instant, at the granularity that stays readable at
 * that distance: "35m", "1h 35m", "6d 3h". The mirror of formatRelativeTime,
 * which counts the other way.
 */
export function formatCountdown(at: number, now = Date.now()): string {
 const minutes = Math.round((at - now) / 60_000);
 if (!Number.isFinite(minutes) || minutes < 1) return "now";
 if (minutes < 60) return `${minutes}m`;
 const hours = Math.floor(minutes / 60);
 if (hours < 24) return `${hours}h ${minutes % 60}m`;
 return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
