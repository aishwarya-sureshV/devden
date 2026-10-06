/** Slider rank for a thinking level; unknown levels sort last, in place. */
const RANK: Record<string, number> = {
 off: 0,
 minimal: 1,
 low: 2,
 medium: 3,
 high: 4,
 xhigh: 5,
 max: 6,
 ultra: 7,
};

/** Rank of a thinking level; unknown levels rank last. */
export const effortRank = (level: string) => RANK[level] ?? 99;

/**
 * Full per-model ladder (synara-style): show every level the selected model
 * supports, up to xhigh/max -- no truncation to the first four. Grok's catalog
 * answers efforts high->low while the slider fills low->high, so rank-sort
 * instead of trusting backend order. A session already sitting on a level the
 * model lacks stays selectable so the user can see what they were on (and
 * move off it), sorted into its ranked slot.
 */
export function effortStops(levels: string[], current: string): string[] {
 const base = [...new Set(levels.filter(Boolean))];
 const list = !current || base.includes(current) ? base : [...base, current];
 if (list.length < 2) return list.length ? list : [current || "off"];
 return [...list].sort((a, b) => (RANK[a] ?? 99) - (RANK[b] ?? 99));
}

/**
 * One ladder for a whole backend menu. Hovering a model used to swap in that
 * model's own list, which re-packed every stop and made the knob jump. The
 * union stays put; the menu only dims levels the model under the pointer
 * does not offer.
 */
export function effortScale(ladders: readonly (readonly string[])[], current: string): string[] {
 const bag: string[] = [];
 for (const ladder of ladders) {
  if (ladder?.length) bag.push(...ladder);
 }
 return effortStops(bag, current);
}

const LABEL: Record<string, string> = { xhigh: "Extra High" };

/** Display name for a thinking level: "xhigh" -> "Extra High", "max" -> "Max". */
export function effortLabel(level: string): string {
 return LABEL[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

/** Placeholder reply time for a level. Keyed by name so a reshaped ladder cannot change it. */
const ESTIMATE: Record<string, string> = {
 off: "~1s",
 minimal: "~2s",
 low: "~2s",
 medium: "~6s",
 high: "~15s",
 xhigh: "~40s",
 max: "~1m",
 ultra: "~2m",
};

export function effortEstimate(level: string): string {
 return ESTIMATE[level] ?? "";
}
