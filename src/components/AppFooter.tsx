import {
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  AGENT_BACKENDS,
  backendMark,
  type AgentBackend,
  type ProviderUsage,
} from "../lib/api";
import { useBackendUsage, usageLeft } from "../lib/backendUsage";
import {
  CUSTOM_SCENE,
  CUSTOM_WALLPAPER,
  cycleBackdrop,
  getAppearance,
  intensityLabel,
  sceneIndex,
  setAppearance,
  setCustomImage,
  subscribeAppearance,
  wallpaperByName,
  type WallpaperMotion,
} from "../lib/appearance";

const MOTIONS: [WallpaperMotion, string][] = [
  ["still", "Still"],
  ["drift", "Drift"],
  ["drift-parallax", "Parallax"],
];

/**
 * App footer (status bar). Right side holds the wallpaper controls from the
 * workbench redesign: ‹ thumbnail + name ›, the motion popover and Custom
 * upload. The left side carries the backend usage meters.
 */
export function AppFooter() {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance);
  const usage = useBackendUsage();
  const [motionOpen, setMotionOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const motionRef = useRef<HTMLButtonElement>(null);

  const wallpaper = wallpaperByName(settings.wallpaper);
  const sceneActive =
    sceneIndex(settings.scene) >= 0 || settings.scene === CUSTOM_SCENE;
  const thumb = sceneActive
    ? undefined
    : settings.wallpaper === CUSTOM_WALLPAPER
      ? (settings.customImage ?? undefined)
      : wallpaper?.thumb;
  const name = sceneActive
    ? settings.scene
    : settings.wallpaper === CUSTOM_WALLPAPER
      ? settings.customImage
        ? CUSTOM_WALLPAPER
        : "None"
      : (wallpaper?.name ?? "None");

  const pickCustom = () => fileRef.current?.click();

  return (
    <footer className="app-footer" role="contentinfo">
      <div className="app-footer__side">
        {AGENT_BACKENDS.map((backend) => (
          <UsageMeter key={backend} backend={backend} usage={usage[backend]} />
        ))}
      </div>
      <div className="app-footer__wall">
        <button
          type="button"
          className="app-footer__btn"
          title="Previous backdrop"
          onClick={() => cycleBackdrop(-1)}
        >
          ‹
        </button>
        <span className="app-footer__wall-name" title={name}>
          {thumb && (
            <i
              className="app-footer__wall-thumb"
              style={{ backgroundImage: `url("${thumb}")` }}
            />
          )}
          <span className="app-footer__wide">{name}</span>
        </span>
        <button
          type="button"
          className="app-footer__btn"
          title="Next backdrop"
          onClick={() => cycleBackdrop(1)}
        >
          ›
        </button>
        <button
          ref={motionRef}
          type="button"
          className="app-footer__btn app-footer__btn--label"
          title={`Wallpaper motion: ${motionLabel(settings.wallpaperMotion)}`}
          aria-expanded={motionOpen}
          onClick={() => setMotionOpen((open) => !open)}
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 9c2-3 4-3 6 0s4 3 6 0" />
          </svg>
          <span className="app-footer__wide">
            {motionLabel(settings.wallpaperMotion)}
          </span>
        </button>
        <button
          type="button"
          className="app-footer__btn app-footer__btn--label"
          title="Use your own image"
          onClick={pickCustom}
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
          </svg>
          <span className="app-footer__wide">Custom</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void setCustomImage(file);
          event.target.value = "";
        }}
      />
      {motionOpen && (
        <MotionPopover
          anchor={motionRef.current}
          settings={settings}
          onClose={() => setMotionOpen(false)}
        />
      )}
    </footer>
  );
}

function motionLabel(motion: WallpaperMotion): string {
  return motion === "still"
    ? "Still"
    : motion === "drift"
      ? "Drift"
      : "Drift + parallax";
}

/** One backend's quota: glyph, % left bar (amber <25%, red <10%), reset on hover. */
function UsageMeter({
  backend,
  usage,
}: {
  backend: AgentBackend;
  usage?: ProviderUsage;
}) {
  const mark = backendMark(backend);
  const { left, text, resetIn } = usageLeft(usage);
  const value = left === null ? (text ?? "—") : `${left}%`;
  const low = left !== null && left < 25;
  const critical = left !== null && left < 10;
  const title = [
    backend,
    left === null ? "no quota data" : `${left}% left`,
    resetIn ? `resets in ${resetIn}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="app-footer__meter" title={title}>
      <span className="app-footer__meter-glyph" style={{ color: mark.color }}>
        {mark.glyph}
      </span>
      <span className="app-footer__meter-bar">
        <i
          className={critical ? "is-critical" : low ? "is-low" : undefined}
          style={{ width: `${left ?? 0}%` }}
        />
      </span>
      <span className={critical ? "is-critical" : low ? "is-low" : undefined}>
        {value}
      </span>
    </span>
  );
}

/** Mode control + intensity slider, anchored above the motion button. */
function MotionPopover({
  anchor,
  settings,
  onClose,
}: {
  anchor: HTMLElement | null;
  settings: ReturnType<typeof getAppearance>;
  onClose: () => void;
}) {
  const scrimStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 40,
  };
  const left = anchor
    ? Math.max(
        8,
        Math.min(
          anchor.getBoundingClientRect().left - 120,
          window.innerWidth - 268,
        ),
      )
    : 8;
  return (
    <>
      <div style={scrimStyle} role="presentation" onClick={onClose} />
      <div className="app-footer__motion" style={{ left }}>
        <div className="app-footer__motion-title">WALLPAPER MOTION</div>
        <div className="seg-control seg-control--footer">
          {MOTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`seg-control__option${settings.wallpaperMotion === id ? " is-active" : ""}`}
              aria-pressed={settings.wallpaperMotion === id}
              onClick={() => setAppearance({ wallpaperMotion: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="app-footer__motion-slider"
          style={{ opacity: settings.wallpaperMotion === "still" ? 0.4 : 1 }}
        >
          <div className="app-footer__motion-row">
            <span>Intensity</span>
            <span>
              {intensityLabel(settings.wallpaperIntensity)} ·{" "}
              {settings.wallpaperIntensity}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={settings.wallpaperIntensity}
            aria-label="Wallpaper motion intensity"
            onChange={(event) =>
              setAppearance({ wallpaperIntensity: Number(event.target.value) })
            }
          />
        </div>
      </div>
    </>
  );
}
