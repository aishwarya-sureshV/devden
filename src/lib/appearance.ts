/**
 * Appearance settings for the workbench redesign: backdrop is EITHER one of
 * the 20 shader scenes (theme) or a full-screen photo wallpaper from the
 * bundled "Scenic backgrounds" set / a custom upload — plus dark/light mode,
 * layout, accent palette, glass (blur/tint) and adjust sliders. One
 * singleton store with localStorage persistence, consumed via
 * useSyncExternalStore.
 */

export type WallpaperMotion = "still" | "drift" | "drift-parallax";

export type AppearanceMode = "light" | "dark" | "system";

/** Workbench surface. Glass keeps the current backdrop. The others are solid
 *  or, for Aurora, a painted field. Cream's panel is the existing warm
 *  paper (`#f4f1e9` in theme.css). */
export type WorkbenchBackground =
  | "glass"
  | "black"
  | "white"
  | "cream"
  | "aurora";

export const WORKBENCH_BACKGROUNDS: WorkbenchBackground[] = [
  "glass",
  "black",
  "white",
  "cream",
  "aurora",
];

export interface AppearanceSettings {
  toolDensity: "compact" | "comfortable";
  toolDurations: boolean;
  /** "Static" keeps the original solid theme; otherwise a scene name. */
  scene: string;
  mode: AppearanceMode;
  /** Fixed to "classic" — the other layouts were removed. */
  layout: "classic";
  palette: string;
  colorStrength: number;
  /** Scenic photo wallpaper name, NO_WALLPAPER, or CUSTOM_WALLPAPER. */
  wallpaper: string;
  /** Drift mode for the photo wallpaper (scenes use `motion`/`speed`). */
  wallpaperMotion: WallpaperMotion;
  /** Wallpaper motion intensity 0–100; 60 is the design's default look. */
  wallpaperIntensity: number;
  blur: number;
  tint: number;
  motion: boolean;
  intensity: number;
  speed: number;
  hue: number;
  saturation: number;
  brightness: number;
  contrast: number;
  /** Highlighted words + every amber accent: "grey" (design chips) or hex. */
  highlight: string;
  /** Hexes the user saved from the wheel picker, newest first. Preferences. */
  savedHighlights: string[];
  /** Panel skin. Glass is the backdrop already in use. */
  background: WorkbenchBackground;
  /** Diff viewer colors per surface tone. */
  diffColors: DiffColors;
  /** Uploaded backdrop image (data URL), shown by the "Custom" scene. */
  customImage: string | null;
}

export const STATIC_SCENE = "Static";
export const CUSTOM_SCENE = "Custom";

export const NO_WALLPAPER = "None";
export const CUSTOM_WALLPAPER = "Custom";
export const WALLPAPER_CATEGORY = "Scenic backgrounds";

export interface Wallpaper {
  name: string;
  image: string;
  thumb: string;
}

/** The bundled HD photo set, served from public/wallpapers. */
export const WALLPAPERS: Wallpaper[] = (
  [
    ["Yosemite Valley", "yosemite-valley"],
    ["Starlit Peaks", "starlit-peaks"],
    ["Misty Ridge", "misty-ridge"],
    ["Alpine Lake", "alpine-lake"],
    ["Summit Light", "summit-light"],
    ["Milky Way", "milky-way"],
    ["Tropical Shore", "tropical-shore"],
    ["Forest Path", "forest-path"],
    ["Rolling Hills", "rolling-hills"],
    ["Waterfall", "waterfall"],
  ] as const
).map(([name, file]) => ({
  name,
  image: `/wallpapers/${file}.webp`,
  thumb: `/wallpapers/${file}-thumb.jpg`,
}));

/** [name, mood, css swatch] — index is the shader scene mode (M uniform). */
export const SCENES: [string, string, string][] = [
  [
    "Aurora Silk",
    "Warped color fields",
    "linear-gradient(135deg,#1b2350,#1d6a73 50%,#b0603f)",
  ],
  [
    "Contour Tide",
    "Topography, rising light",
    "repeating-radial-gradient(circle at 30% 60%,#0c1216 0 6px,#3a8f93 7px 8px),#0c1216",
  ],
  [
    "Caustic Pool",
    "Light through water",
    "radial-gradient(circle at 40% 40%,#4fb7c0,#0c3440 70%)",
  ],
  [
    "Nebula Drift",
    "Deep-space clouds",
    "radial-gradient(circle at 30% 40%,#5a2a72,#0b0a1a 70%)",
  ],
  [
    "Silk Threads",
    "Filaments of light",
    "linear-gradient(170deg,#0b0b14 30%,#6e57d8 48%,#e28a6a 52%,#0b0b14 70%)",
  ],
  [
    "Glass Cells",
    "Shifting stained glass",
    "conic-gradient(from 40deg,#27405c,#4a2c5e,#5e3a2c,#2c5e4d,#27405c)",
  ],
  [
    "Snowfall",
    "Quiet night in the hills",
    "linear-gradient(180deg,#0e1424,#1d2638 70%,#2a3346)",
  ],
  [
    "Rainy Window",
    "City lights behind glass",
    "radial-gradient(circle at 25% 60%,#b0703c 0 8%,transparent 20%),radial-gradient(circle at 70% 35%,#3c6aa6 0 7%,transparent 18%),#0e0e16",
  ],
  [
    "Moonlit Shore",
    "Waves on a night beach",
    "linear-gradient(180deg,#0b2a33 0 55%,#8a9aa0 57%,#2a2320 60%)",
  ],
  [
    "Fireflies",
    "Forest clearing at dusk",
    "radial-gradient(circle at 30% 40%,#d9e27a 0 3%,transparent 12%),radial-gradient(circle at 70% 65%,#d9e27a 0 2%,transparent 10%),#0b1814",
  ],
  [
    "Golden Hour",
    "Slow clouds at sunset",
    "linear-gradient(180deg,#1a1834,#6d3a3a 70%,#b0684a)",
  ],
  [
    "Pond Rain",
    "Rain rings on still water",
    "repeating-radial-gradient(circle at 45% 55%,#0c1c20 0 9px,#3d7680 10px 11px),#0c1c20",
  ],
  [
    "Beach Waves",
    "Sunset surf rolling in",
    "linear-gradient(180deg,#3a2436 0 38%,#1c3346 42% 70%,#b9c3c6 72%,#3a2e28 76%)",
  ],
  [
    "Mountains",
    "Misty ridges at dawn",
    "linear-gradient(180deg,#4a3048 0 30%,#2a2440 30% 55%,#141a2a 55% 75%,#0a0d16 75%)",
  ],
  [
    "Dune Sea",
    "Night dunes / noon sand",
    "linear-gradient(100deg,#0d0b16 0 50%,#f3dcc8 50%),radial-gradient(ellipse at 25% 90%,#3a2a40,transparent 60%)",
  ],
  [
    "Ink Wash",
    "Sumi ink bleeding into paper",
    "linear-gradient(100deg,#07080b 0 50%,#f3f1ea 50%)",
  ],
  [
    "Halftone",
    "Drifting two-ink dot screen",
    "radial-gradient(circle,#ee5a8c 30%,transparent 34%) 0 0/9px 9px,radial-gradient(circle,#3f72e8 30%,transparent 34%) 4px 4px/9px 9px,linear-gradient(100deg,#0a0a12 0 50%,#f4f1ec 50%)",
  ],
  [
    "Ridgelines",
    "Stacked signal lines",
    "repeating-linear-gradient(180deg,transparent 0 6px,#8fb8d8 6px 7px),linear-gradient(100deg,#07090e 0 50%,#b9b6c8 50%)",
  ],
  [
    "Cloud Deck",
    "Above the clouds, moon or sun",
    "linear-gradient(100deg,#0a0f1e 0 50%,#b9d3ec 50%)",
  ],
  [
    "Aquarelle",
    "Watercolor blooms",
    "radial-gradient(circle at 30% 40%,#6f95da,transparent 40%),radial-gradient(circle at 70% 60%,#e87d8b,transparent 40%),radial-gradient(circle at 55% 25%,#efbb5c,transparent 35%),linear-gradient(100deg,#0a0a10 0 50%,#f3efe6 50%)",
  ],
];

/** Gallery grouping from the mockup. */
export const SCENE_GROUPS: { label: string; indices: number[] }[] = [
  { label: "Day & night · drawn for both", indices: [14, 15, 16, 17, 18, 19] },
  { label: "Getaways", indices: [6, 7, 12, 8, 13, 9, 10, 11] },
  { label: "Abstract", indices: [0, 1, 2, 3, 4, 5] },
];

/** ‹ › cycle order from the mockup: new, getaways, abstract. */
const CYCLE_ORDER = [
  14, 15, 16, 17, 18, 19, 6, 7, 12, 8, 13, 9, 10, 11, 0, 1, 2, 3, 4, 5,
];

/** [name, hex triplet or null for Original] — tints the backdrop shader. */
export const PALETTES: [string, string[] | null][] = [
  ["Original", null],
  ["Rose", ["#ff5f8f", "#ff9a7a", "#c77dff"]],
  ["Peach", ["#ff8f66", "#ffc46b", "#ff6f91"]],
  ["Amber", ["#f2b33d", "#ff7a4d", "#e8d86a"]],
  ["Sage", ["#8cc46e", "#5fbfa0", "#d9c86a"]],
  ["Teal", ["#2fc4b2", "#4aa3ff", "#7be0a0"]],
  ["Sky", ["#4aa3ff", "#7cd4ff", "#a585ff"]],
  ["Lavender", ["#a585ff", "#ff8ad8", "#6aa8ff"]],
  ["Plum", ["#d06ad8", "#6a5cff", "#ff6f91"]],
];

/**
 * Highlight swatches: the selected color replaces every amber in the app
 * (accent overlays like New session / Auto mode, yellow badges, highlighted
 * words). Amber and Copper are the project's original ambers; "grey" keeps
 * the design's neutral chip. Values are hex or "grey".
 */
export const HIGHLIGHTS: [string, string][] = [
  ["Amber", "#e8a765"],
  ["Gold", "#d9b972"],
  ["Bronze", "#c4a06a"],
  ["Grey", "grey"],
  // Rose onward are intensity-reduced versions of the original neons so the
  // first four (project ambers + neutral) keep their warm identity while the
  // cool colors read as tints, not neon signs.
  ["Rose", "#e28ca3"],
  ["Peach", "#e8a583"],
  ["Mint", "#8ecdb2"],
  ["Teal", "#7cb5ad"],
  ["Sky", "#84aade"],
  ["Lavender", "#a99bdc"],
  ["Plum", "#b98ac4"],
];

/** Diff viewer colors, one picker per role. `dark` paints Glass/Black/Aurora,
 *  `light` paints White/Cream. App.tsx exposes them as `--dv-<role>`. */
export const DIFF_ROLES = [
  ["kw", "Keywords"],
  ["cmd", "Commands & storage"],
  ["fn", "Functions"],
  ["var", "Variables & types"],
  ["str", "Strings"],
  ["flag", "Flags & properties"],
  ["pun", "Punctuation"],
  ["com", "Comments"],
  ["cst", "Numbers & constants"],
  ["add", "Added lines"],
  ["del", "Removed lines"],
] as const;
export type DiffRole = (typeof DIFF_ROLES)[number][0];
export type DiffTone = "dark" | "light";
export type DiffColors = Record<DiffTone, Record<DiffRole, string>>;

const diffSet = (hexes: string): Record<DiffRole, string> => {
  const list = hexes.split(" ");
  return Object.fromEntries(DIFF_ROLES.map(([role], i) => [role, list[i]!])) as Record<DiffRole, string>;
};
export const DEFAULT_DIFF_COLORS: DiffColors = {
  dark: diffSet("#d58cff #ff9f43 #4dabff #3ee0ff #ffd84d #ff6bcb #a0a8ff #7a7f9a #ff5f6d #62e3b4 #ff8f9c"),
  light: diffSet("#9d1ff0 #e8590c #0b63f6 #0091c2 #b8860b #d6247a #5b5bd6 #8e93a6 #e01e3c #0f8259 #c4304a"),
};

export const diffTone = (background: WorkbenchBackground): DiffTone =>
  background === "white" || background === "cream" ? "light" : "dark";

export function setDiffColor(tone: DiffTone, role: DiffRole, hex: string): void {
  const colors = settings.diffColors;
  setAppearance({ diffColors: { ...colors, [tone]: { ...colors[tone], [role]: hex } } });
}

export function resetDiffColors(tone: DiffTone): void {
  setAppearance({ diffColors: { ...settings.diffColors, [tone]: DEFAULT_DIFF_COLORS[tone] } });
}

/** Stored colors over the defaults; anything that isn't a #rrggbb is dropped. */
function loadDiffColors(stored: unknown): DiffColors {
  const pick = (tone: DiffTone) => {
    const saved = (stored as Partial<DiffColors> | undefined)?.[tone] ?? {};
    const out = { ...DEFAULT_DIFF_COLORS[tone] };
    for (const [role] of DIFF_ROLES) {
      const hex = (saved as Record<string, unknown>)[role];
      if (typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex)) out[role] = hex;
    }
    return out;
  };
  return { dark: pick("dark"), light: pick("light") };
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  toolDensity: "compact",
  toolDurations: true,
  scene: STATIC_SCENE,
  mode: "light",
  layout: "classic",
  wallpaper: WALLPAPERS[0].name,
  wallpaperMotion: "drift-parallax",
  wallpaperIntensity: 60,
  palette: "Original",
  colorStrength: 0.8,
  blur: 22,
  tint: 0.58,
  motion: true,
  intensity: 0.8,
  speed: 0.9,
  hue: 0,
  saturation: 1,
  brightness: 1,
  contrast: 1,
  highlight: "#e8a765",
  // First migration seeds the saved list with the shipped swatches so the
  // dropdown isn't empty; from then on the list is purely user-saved.
  savedHighlights: HIGHLIGHTS.flatMap(([, value]) =>
    value === "grey" ? [] : [value],
  ),
  customImage: null,
  background: "glass",
  diffColors: DEFAULT_DIFF_COLORS,
};

const STORAGE_KEY = "devden.appearance.v1";


const listeners = new Set<() => void>();
let settings: AppearanceSettings = load();

function load(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = { ...DEFAULT_APPEARANCE };
      // Existing users keep their dark/light choice from the pre-redesign
      // settings key on first load.
      if (localStorage.getItem("devden.theme.v2") === "dark")
        seeded.mode = "dark";
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings> & {
      /** Fields from the wallpapers-only intermediate build. */
      motion?: unknown;
      motionIntensity?: unknown;
    };
    const merged = { ...DEFAULT_APPEARANCE, ...parsed };
    if (Array.isArray(parsed.savedHighlights))
      merged.savedHighlights = parsed.savedHighlights.filter(
        (hex): hex is string =>
          typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex),
      );
    else merged.savedHighlights = DEFAULT_APPEARANCE.savedHighlights;
    // Islands/Rail/Top were removed; the app is always classic now.
    merged.layout = "classic";
    // Scene users keep their scene: the wallpaper only enters when they pick
    // one. An old "Custom" image upload becomes the custom wallpaper.
    if (parsed.wallpaper == null)
      merged.wallpaper =
        parsed.scene === CUSTOM_SCENE ? CUSTOM_WALLPAPER : NO_WALLPAPER;
    // The shader's motion is a boolean; the wallpaper's is a mode + 0-100
    // intensity. Intermediate builds stored both under `motion`.
    const storedMotion: unknown = parsed.motion;
    if (typeof storedMotion !== "boolean") merged.motion = true;
    if (typeof parsed.wallpaperMotion !== "string")
      merged.wallpaperMotion =
        storedMotion === "still"
          ? "still"
          : storedMotion === "drift"
            ? "drift"
            : "drift-parallax";
    if (typeof parsed.wallpaperIntensity !== "number")
      merged.wallpaperIntensity =
        typeof parsed.motionIntensity === "number"
          ? Math.max(0, Math.min(100, Math.round(parsed.motionIntensity)))
          : 60;
    merged.wallpaperIntensity = Math.max(
      0,
      Math.min(100, merged.wallpaperIntensity),
    );
    merged.diffColors = loadDiffColors(parsed.diffColors);
    if (!WORKBENCH_BACKGROUNDS.includes(merged.background))
      merged.background = "glass";
    if (
      merged.mode !== "light" &&
      merged.mode !== "dark" &&
      merged.mode !== "system"
    )
      merged.mode = DEFAULT_APPEARANCE.mode;
    return merged;
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode / quota — settings just won't stick.
  }
}

export function getAppearance(): AppearanceSettings {
  return settings;
}

export function setAppearance(patch: Partial<AppearanceSettings>): void {
  const next: AppearanceSettings = { ...settings, ...patch };
  const sceneTouched = Object.hasOwn(patch, "scene");
  const wallTouched = Object.hasOwn(patch, "wallpaper");
  // A shader theme and a photo can't show at once: the photo layer used to
  // win, so picking a restored theme did nothing while a wallpaper was on.
  if (sceneTouched && !wallTouched) next.wallpaper = NO_WALLPAPER;
  if (
    wallTouched &&
    !sceneTouched &&
    patch.wallpaper != null &&
    patch.wallpaper !== NO_WALLPAPER
  )
    next.scene = STATIC_SCENE;
  settings = next;
  persist();
  for (const listener of listeners) listener();
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Persist the picked color to the saved list (deduped, newest first). */
export function addSavedHighlight(hex: string): void {
  setAppearance({
    savedHighlights: [
      hex,
      ...settings.savedHighlights.filter((saved) => saved !== hex),
    ].slice(0, 30),
  });
}

export function removeSavedHighlight(hex: string): void {
  setAppearance({
    savedHighlights: settings.savedHighlights.filter((saved) => saved !== hex),
  });
}

/** Shader scene index, or -1 for the static theme. */
export function sceneIndex(name = settings.scene): number {
  return SCENES.findIndex((scene) => scene[0] === name);
}

/** Step through scenes with ‹ › — static sits at the end of the loop. */
export function cycleScene(step: 1 | -1): void {
  const current = sceneIndex();
  if (current < 0) {
    // Static → first scene in cycle order (or last when going backwards).
    setAppearance({
      scene:
        SCENES[
          step > 0 ? CYCLE_ORDER[0] : CYCLE_ORDER[CYCLE_ORDER.length - 1]
        ][0],
    });
    return;
  }
  const at = CYCLE_ORDER.indexOf(current);
  const next =
    CYCLE_ORDER[(at + step + CYCLE_ORDER.length) % CYCLE_ORDER.length];
  setAppearance({ scene: SCENES[next][0] });
}

/** Hex triplet for the active palette, or null when Original. */
export function paletteColors(name = settings.palette): string[] | null {
  const found = PALETTES.find((palette) => palette[0] === name);
  return found ? found[1] : null;
}

export function sceneSwatch(name: string): string {
  const index = sceneIndex(name);
  return index < 0
    ? "linear-gradient(135deg,#f4f1e9 50%,#12110f 50%)"
    : SCENES[index][2];
}

export function wallpaperByName(name = settings.wallpaper): Wallpaper | null {
  return WALLPAPERS.find((wallpaper) => wallpaper.name === name) ?? null;
}

/** The photo URL for the active wallpaper, or null when no photo is active. */
export function photoBackdrop(s = settings): string | null {
  if (s.wallpaper === CUSTOM_WALLPAPER) return s.customImage;
  return wallpaperByName(s.wallpaper)?.image ?? null;
}

/** Wallpaper photo, or the uploaded image when the Custom theme is selected. */
export function activePhoto(s = settings): string | null {
  return photoBackdrop(s) ?? (s.scene === CUSTOM_SCENE ? s.customImage : null);
}

/** ‹ › and [ ] step through wallpapers when one is active (or chosen). */
const WALLPAPER_CYCLE = [
  ...WALLPAPERS.map((wallpaper) => wallpaper.name),
  CUSTOM_WALLPAPER,
  NO_WALLPAPER,
];

export function cycleWallpaper(step: 1 | -1): void {
  const at = WALLPAPER_CYCLE.indexOf(settings.wallpaper);
  const next =
    WALLPAPER_CYCLE[
      (at + step + WALLPAPER_CYCLE.length) % WALLPAPER_CYCLE.length
    ];
  setAppearance({ wallpaper: next });
}

/** [ ] and the footer arrows step through whichever backdrop is showing. */
export function cycleBackdrop(step: 1 | -1): void {
  if (sceneIndex() >= 0 || settings.scene === CUSTOM_SCENE) cycleScene(step);
  else cycleWallpaper(step);
}

/** Motion intensity labels: Off (0), Gentle (<35), Medium (<75), Strong. */
export function intensityLabel(value: number): string {
  return value === 0
    ? "Off"
    : value < 35
      ? "Gentle"
      : value < 75
        ? "Medium"
        : "Strong";
}

/** True when a scene or an uploaded image paints the backdrop (glass on). */
export function hasBackdrop(s = settings): boolean {
  return (
    sceneIndex(s.scene) >= 0 ||
    s.scene === CUSTOM_SCENE ||
    photoBackdrop(s) !== null
  );
}

export function isGlass(): boolean {
  return sceneIndex() >= 0;
}

/* ponytail: data URL in localStorage (~5MB quota) — oversized stores just
   don't persist (existing catch); move to IndexedDB if users hit it. */
async function readImage(file: File): Promise<string> {
  const raw = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  if (file.size < 400 * 1024) return raw();
  try {
    // Shrink big wallpapers so the data URL fits localStorage.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")!
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return raw();
  }
}

/** Upload a downloaded image file and make it the backdrop. */
export async function setCustomImage(file: File): Promise<void> {
  const dataUrl = await readImage(file);
  setAppearance({
    customImage: dataUrl,
    wallpaper: CUSTOM_WALLPAPER,
    scene: STATIC_SCENE,
  });
}

/** CSS filter string for the backdrop canvas adjust sliders. */
export function canvasFilter(s: AppearanceSettings): string {
  return `blur(${s.blur}px) hue-rotate(${s.hue}deg) saturate(${s.saturation}) brightness(${s.brightness}) contrast(${s.contrast})`;
}

/** Adjust sliders for the photo wallpaper — blur lives on the photo layer
 *  the same way the old canvas blurred the scene, so panes never read as
 *  overlays; the photo's own color keeps the sliders honest. */
export function photoFilter(s: AppearanceSettings): string {
  return `hue-rotate(${s.hue}deg) saturate(${s.saturation}) brightness(${s.brightness}) contrast(${s.contrast})`;
}

/**
 * Body style vars for the highlight picker: "grey" keeps the design's grey
 * chip; any other choice colors highlighted words and replaces every amber
 * accent (--pw-yellow / --ds-status-warning / js file dots) with the hex.
 */
function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  // Rec. 709 approximation from the 8-bit channels.
  return (
    (0.299 * ((value >> 16) & 255) +
      0.587 * ((value >> 8) & 255) +
      0.114 * (value & 255)) /
    255
  );
}

export function highlightVars(highlight: string): Record<string, string> {
  const grey = highlight === "grey";
  const hex = grey ? "#b9b7c4" : highlight;
  // Send button follows the accent too. Pick a legible foreground from the
  // hex's luminance; grey keeps the design's neutral send button.
  const send: Record<string, string> = {};
  if (!grey) {
    const darkFg = relativeLuminance(hex) > 0.45;
    send["--send"] = hex;
    send["--sendFg"] = darkFg ? "#1b0f0a" : "rgb(255 255 255 / 0.92)";
  }
  return {
    "--g-highlight": hex,
    ...send,
    "--hl-chip-color": grey ? "var(--g-fg)" : hex,
    "--hl-chip-bg": grey
      ? "rgb(var(--g-ink) / 0.08)"
      : `color-mix(in srgb, ${hex} 10%, transparent)`,
    "--hl-ring": grey
      ? "rgb(var(--g-ink) / 0.06)"
      : `color-mix(in srgb, ${hex} 28%, transparent)`,
  };
}
