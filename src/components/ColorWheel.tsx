import { useRef, useState, useSyncExternalStore } from "react";
import {
  addSavedHighlight,
  getAppearance,
  HIGHLIGHTS,
  removeSavedHighlight,
  setAppearance,
  subscribeAppearance,
} from "../lib/appearance";

// ponytail: hand-rolled HSV picker so it lays out as the wheel card the
// design wants; swap to a headless picker lib if curves (contrast/harmony)
// get requested later.

type Hsv = { h: number; s: number; v: number };

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `#${[f(5), f(3), f(1)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** "grey" (and anything malformed) falls back to the amber home color. */
function hexToHsv(hex: string): Hsv {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return { h: 30, s: 0.5, v: 0.91 };
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const h =
    d === 0
      ? 0
      : max === r
        ? ((g - b) / d + (g < b ? 6 : 0)) * 60
        : max === g
          ? ((b - r) / d + 2) * 60
          : ((r - g) / d + 4) * 60;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function colorName(hex: string): string {
  return HIGHLIGHTS.find(([, other]) => other === hex)?.[0] ?? "custom";
}

/** Point → hue angle around the ring's center, degrees clockwise from top. */
function ringHue(event: { clientX: number; clientY: number }, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

/**
 * Full HSV wheel picker. `floating` (conversation) keeps the hub toggle;
 * `inline` (settings) is an always-open card with the save + saved list.
 */
export function ColorWheel({
  variant = "floating",
}: {
  variant?: "floating" | "inline";
}) {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance);
  const [open, setOpen] = useState(variant === "inline");
  const [savedOpen, setSavedOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const ringRef = useRef<HTMLDivElement | null>(null);
  const squareRef = useRef<HTMLDivElement | null>(null);
  const hex = isHex(appearance.highlight) ? appearance.highlight : "#b9b7c4";
  const hsv = hexToHsv(appearance.highlight);

  const point = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    apply(
      event.clientX,
      event.clientY,
      event.currentTarget === ringRef.current,
    );
  };
  const move = (event: React.PointerEvent) =>
    apply(
      event.clientX,
      event.clientY,
      event.currentTarget === ringRef.current,
    );
  const apply = (clientX: number, clientY: number, ring: boolean) => {
    let next: Partial<Hsv> = {};
    if (ring && ringRef.current) {
      next = { h: ringHue({ clientX, clientY }, ringRef.current) };
    } else if (!ring && squareRef.current) {
      const rect = squareRef.current.getBoundingClientRect();
      next = {
        s: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        v: 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
      };
    }
    setAppearance({ highlight: hsvToHex({ ...hsv, ...next }) });
  };

  const copy = () => {
    navigator.clipboard.writeText(hex);
    setFlash("copied");
    setTimeout(() => setFlash(""), 900);
  };
  const save = () => {
    addSavedHighlight(hex);
    setFlash("saved");
    setSavedOpen(true);
    setTimeout(() => setFlash(""), 900);
  };

  const size = 148;
  const ringWidth = 22;
  const square = 86;
  const thumbAngle = (hsv.h * Math.PI) / 180;
  const ringRadius = size / 2 - ringWidth / 2;

  return (
    <div
      className={`color-wheel color-wheel--${variant}${open ? " is-open" : ""}`}
    >
      {variant === "floating" && (
        <div
          className="color-wheel__hub"
          title="Highlight color picker"
          onClick={() => setOpen(!open)}
          style={{ ["--cw-color" as string]: hex }}
        />
      )}
      {open && (
        <div className="color-wheel__panel">
          <div
            ref={ringRef}
            className="color-wheel__ring"
            style={{
              ["--cw-size" as string]: `${size}px`,
              ["--cw-ring" as string]: `${ringWidth}px`,
            }}
            onPointerDown={point}
            onPointerMove={(event) => event.buttons && move(event)}
          >
            <i
              className="color-wheel__thumb color-wheel__thumb--ring"
              style={{
                ["--cw-x" as string]: `${size / 2 + Math.sin(thumbAngle) * ringRadius}px`,
                ["--cw-y" as string]: `${size / 2 - Math.cos(thumbAngle) * ringRadius}px`,
              }}
            />
          </div>
          <div
            ref={squareRef}
            className="color-wheel__square"
            style={{
              ["--cw-size" as string]: `${square}px`,
              ["--cw-hue" as string]: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
            }}
            onPointerDown={point}
            onPointerMove={(event) => event.buttons && move(event)}
          >
            <i
              className="color-wheel__thumb color-wheel__thumb--square"
              style={{
                ["--cw-x" as string]: `${hsv.s * square}px`,
                ["--cw-y" as string]: `${(1 - hsv.v) * square}px`,
              }}
            />
          </div>
          <div className="color-wheel__bar">
            <button
              type="button"
              className="color-wheel__hex"
              title="Click to copy"
              onClick={copy}
            >
              <span
                className="color-wheel__hex-dot"
                style={{ background: hex }}
              />
              <b>{hex}</b>
              {flash && <em>{flash}</em>}
            </button>
            <button
              type="button"
              className="color-wheel__save"
              title="Save this color as a preference"
              onClick={save}
            >
              Save
            </button>
            <div className="color-wheel__saved">
              <button
                type="button"
                className="color-wheel__saved-toggle"
                onClick={() => setSavedOpen(!savedOpen)}
              >
                Saved ({appearance.savedHighlights.length})
              </button>
              {savedOpen && (
                <div className="color-wheel__saved-list">
                  {appearance.savedHighlights.length === 0 && (
                    <div className="color-wheel__saved-row color-wheel__saved-row--empty">
                      Nothing saved yet
                    </div>
                  )}
                  {appearance.savedHighlights.map((saved) => (
                    <div key={saved} className="color-wheel__saved-row">
                      <button
                        type="button"
                        className="color-wheel__saved-pick"
                        title={`Use ${saved}`}
                        onClick={() => setAppearance({ highlight: saved })}
                      >
                        <span
                          className="color-wheel__hex-dot"
                          style={{ background: saved }}
                        />
                        <b>{saved}</b>
                      </button>
                      <button
                        type="button"
                        className="color-wheel__saved-remove"
                        title="Remove"
                        onClick={() => removeSavedHighlight(saved)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
