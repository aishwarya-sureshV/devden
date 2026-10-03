import { useRef, useState, useSyncExternalStore } from "react";
import {
  CUSTOM_SCENE,
  CUSTOM_WALLPAPER,
  HIGHLIGHTS,
  NO_WALLPAPER,
  SCENES,
  SCENE_GROUPS,
  STATIC_SCENE,
  WALLPAPERS,
  getAppearance,
  photoBackdrop,
  sceneIndex,
  setAppearance,
  setCustomImage,
  subscribeAppearance,
  wallpaperByName,
  type AppearanceMode,
  type AppearanceSettings,
  type WallpaperMotion,
  type WorkbenchBackground,
} from "../lib/appearance";
import { DiffColorEditor } from "./DiffColorEditor";

const CATS = ["Scenic", "Day & Night", "Getaways", "Abstract", "Yours"] as const;
type Cat = (typeof CATS)[number];

const SURFACES: {
  id: WorkbenchBackground;
  label: string;
  help: string;
  swatch: string;
}[] = [
  {
    id: "glass",
    label: "Glass",
    help: "Panes float over the backdrop.",
    swatch:
      "linear-gradient(135deg,rgba(255,255,255,.5),rgba(255,255,255,.08))",
  },
  {
    id: "black",
    label: "Black",
    help: "Solid near-black. Backdrop hidden.",
    swatch: "#0a0b0e",
  },
  {
    id: "white",
    label: "White",
    help: "Solid white. Backdrop hidden.",
    swatch: "#eceae6",
  },
  {
    id: "cream",
    label: "Cream",
    help: "Warm paper. Backdrop hidden.",
    swatch: "#e9dfcc",
  },
  {
    id: "aurora",
    label: "Aurora",
    help: "A soft color field behind the panes.",
    swatch: "linear-gradient(135deg,#2a3c8a,#1e8a86,#d47a4a)",
  },
];

const ADJUST = {
  blur: 22,
  tint: 0.58,
  hue: 0,
  saturation: 1,
  brightness: 1,
  contrast: 1,
};

const GREY = "#b9b7c4";

/**
 * Appearance page from the settings redesign: theme, backdrop, adjust,
 * accent, and thinking, on one scroll. Fills use the workbench's own tokens.
 */
export function SettingsAppearance({
  showThinking,
  onShowThinkingChange,
}: {
  /** Omitted in the explorer's quick panel, which hides that row. */
  showThinking?: boolean;
  onShowThinkingChange?: (show: boolean) => void;
}) {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState<Cat | null>(null);
  const [drag, setDrag] = useState(false);
  const current = describe(settings);
  const shown = cat ?? current.cat;
  const surface =
    SURFACES.find((item) => item.id === (settings.background ?? "glass")) ??
    SURFACES[0];
  const photo = photoBackdrop(settings) !== null;
  const animOn = photo
    ? settings.wallpaperMotion !== "still"
    : settings.motion;
  const offGlass = (settings.background ?? "glass") !== "glass";
  const tiles = tilesFor(shown, settings);
  const yoursEmpty = shown === "Yours" && !settings.customImage;
  const adjusted = (Object.keys(ADJUST) as (keyof typeof ADJUST)[]).some(
    (key) => Math.abs(settings[key] - ADJUST[key]) > 0.001,
  );
  const highlightHex =
    settings.highlight === "grey" ? GREY : settings.highlight;
  const knownHighlight = HIGHLIGHTS.some(
    ([, value]) => value.toLowerCase() === settings.highlight.toLowerCase(),
  );

  const addImage = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    void setCustomImage(file).then(() =>
      setAppearance({ background: "glass" }),
    );
    setCat("Yours");
  };

  const step = (dir: 1 | -1) => {
    const list = tiles.filter((tile) => tile.pick);
    if (!list.length) return;
    const at = list.findIndex((tile) => tile.active);
    const index =
      at < 0
        ? dir > 0
          ? 0
          : list.length - 1
        : (at + dir + list.length) % list.length;
    list[index]?.pick();
  };

  return (
    <>
      <section className="settings-block">
        <div className="settings-block__label">Theme</div>
        <div className="settings-group">
          <div className="settings-field">
            <div className="settings-field__text">
              <strong>Mode</strong>
              <span>System follows macOS.</span>
            </div>
            <Segmented
              options={[
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
                { id: "system", label: "System" },
              ]}
              active={settings.mode}
              onPick={(id) =>
                setAppearance({ mode: id as AppearanceMode })
              }
            />
          </div>
          <div className="settings-field">
            <div className="settings-field__text">
              <strong>Surface</strong>
              <span>{surface.help}</span>
            </div>
            <div
              className="seg-control seg-control--inline"
              role="group"
              aria-label="Surface"
            >
              {SURFACES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`seg-control__option${
                    item.id === surface.id ? " is-active" : ""
                  }`}
                  aria-pressed={item.id === surface.id}
                  onClick={() =>
                    setAppearance({
                      background: item.id,
                    })
                  }
                >
                  <i
                    className="settings-swatch-dot"
                    style={{ background: item.swatch }}
                  />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field__text">
              <strong>Code colors</strong>
              <span>Pick a color for each part of the code. Applies to diffs, edit cards, the file editor and chat code blocks, live.</span>
            </div>
            <DiffColorEditor />
          </div>
        </div>
      </section>

      <section
        className="settings-block"
        onDragOver={(event) => {
          event.preventDefault();
          if (!drag) setDrag(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDrag(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          addImage(
            [...event.dataTransfer.files].find((file) =>
              file.type.startsWith("image/"),
            ),
          );
        }}
      >
        <div className="settings-block__head">
          <span className="settings-block__label">Backdrop</span>
          <span className="settings-block__aside">
            <kbd>[</kbd>
            <kbd>]</kbd>
            cycle
          </span>
        </div>
        <div className="settings-group">
          <div className="settings-current">
            <i
              className={`settings-current__tile${current.photo ? " is-photo" : ""}`}
              style={
                current.photo
                  ? { backgroundImage: `url("${current.swatch}")` }
                  : { background: current.swatch }
              }
            />
            <div className="settings-field__text">
              <strong>{current.name}</strong>
              <span>
                {current.cat}
                {offGlass ? " · not showing" : ""}
              </span>
            </div>
            <div className="settings-current__nav">
              <button type="button" title="Previous  [" onClick={() => step(-1)}>
                ‹
              </button>
              <button type="button" title="Next  ]" onClick={() => step(1)}>
                ›
              </button>
            </div>
          </div>
          {offGlass && (
            <div className="settings-note">
              <i />
              Hidden by the {surface.label} surface. Picking a backdrop
              switches to Glass.
            </div>
          )}
          <div className="settings-pills" role="tablist" aria-label="Backdrop categories">
            {CATS.map((name) => {
              const count =
                name === "Yours"
                  ? settings.customImage
                    ? "1"
                    : ""
                  : String(countFor(name));
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={shown === name}
                  className={`settings-pill${shown === name ? " is-active" : ""}`}
                  onClick={() => setCat(name)}
                >
                  {name}
                  {count && <span>{count}</span>}
                </button>
              );
            })}
          </div>
          <div className={`settings-tiles-wrap${offGlass ? " is-dim" : ""}`}>
            {yoursEmpty ? (
              <button
                type="button"
                className="settings-dropzone"
                onClick={() => fileRef.current?.click()}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
                </svg>
                <strong>Drop images here or browse</strong>
                <span>Add as many as you like. JPG, PNG, WebP or HEIC.</span>
              </button>
            ) : (
              <div className="settings-tiles">
                {tiles.map((tile) => (
                  <div key={tile.id} className="settings-tile">
                    <button
                      type="button"
                      className={`settings-tile__pic${tile.active ? " is-active" : ""}${tile.photo ? " is-photo" : ""}`}
                      title={tile.desc}
                      style={
                        tile.photo
                          ? { backgroundImage: `url("${tile.swatch}")` }
                          : { background: tile.swatch }
                      }
                      onClick={tile.pick}
                    >
                      {tile.active && (
                        <span className="settings-tile__check">✓</span>
                      )}
                    </button>
                    {tile.remove && (
                      <button
                        type="button"
                        className="settings-tile__remove"
                        title="Remove image"
                        onClick={tile.remove}
                      >
                        ×
                      </button>
                    )}
                    <span className={tile.active ? "is-active" : ""}>
                      {tile.name}
                    </span>
                  </div>
                ))}
                {shown === "Yours" && settings.customImage && (
                  <div className="settings-tile">
                    <button
                      type="button"
                      className="settings-tile__add"
                      onClick={() => fileRef.current?.click()}
                    >
                      +
                    </button>
                    <span>Add images</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="settings-field">
            <div className="settings-field__text">
              <strong>Animate backdrop</strong>
              <span>Slow drift. Off when Reduce Motion is on.</span>
            </div>
            <Toggle
              on={animOn}
              label="Animate backdrop"
              onToggle={() => {
                if (photo)
                  setAppearance({
                    wallpaperMotion: animOn
                      ? "still"
                      : ("drift-parallax" as WallpaperMotion),
                  });
                else setAppearance({ motion: !settings.motion });
              }}
            />
          </div>
          {animOn && (
            <div className="settings-group__sliders">
              {!photo && (
                <Slider
                  label="Speed"
                  min={0}
                  max={3}
                  step={0.1}
                  value={settings.speed}
                  display={`${settings.speed.toFixed(1)}×`}
                  onChange={(speed) => setAppearance({ speed })}
                />
              )}
              <Slider
                label="Intensity"
                min={photo ? 0 : 0.3}
                max={photo ? 100 : 1.8}
                step={photo ? 1 : 0.05}
                value={photo ? settings.wallpaperIntensity : settings.intensity}
                display={
                  photo
                    ? `${Math.round(settings.wallpaperIntensity)}%`
                    : pct(settings.intensity)
                }
                onChange={(value) =>
                  photo
                    ? setAppearance({ wallpaperIntensity: value })
                    : setAppearance({ intensity: value })
                }
              />
            </div>
          )}
        </div>
        {drag && <div className="settings-drop">Drop to add to Yours</div>}
      </section>

      <section className="settings-block">
        <div className="settings-block__head">
          <span className="settings-block__label">Adjust</span>
          {adjusted && (
            <button
              type="button"
              className="settings-text-btn"
              onClick={() => setAppearance(ADJUST)}
            >
              Reset
            </button>
          )}
        </div>
        <div className="settings-group settings-group__sliders">
          <div className="settings-group__sub">Glass panes</div>
          <Slider
            label="Blur"
            min={0}
            max={40}
            step={1}
            value={settings.blur}
            display={`${Math.round(settings.blur)}px`}
            onChange={(blur) => setAppearance({ blur })}
          />
          <Slider
            label="Tint"
            min={0}
            max={0.7}
            step={0.01}
            value={settings.tint}
            display={pct(settings.tint)}
            onChange={(tint) => setAppearance({ tint })}
          />
          <div className="settings-group__rule" />
          <div className="settings-group__sub">Backdrop color</div>
          <Slider
            label="Hue"
            min={-180}
            max={180}
            step={1}
            value={settings.hue}
            display={`${Math.round(settings.hue)}°`}
            track="linear-gradient(90deg,#5ad6e6,#5a7aff,#c45aff,#ff5ab4,#ff5a5a,#ffb85a,#e6e65a,#5ae67a,#5ad6e6)"
            onChange={(hue) => setAppearance({ hue })}
          />
          <Slider
            label="Saturation"
            min={0}
            max={2}
            step={0.01}
            value={settings.saturation}
            display={pct(settings.saturation)}
            track="linear-gradient(90deg,#8a8a8a,#ff4a6a)"
            onChange={(saturation) => setAppearance({ saturation })}
          />
          <Slider
            label="Brightness"
            min={0.4}
            max={1.6}
            step={0.01}
            value={settings.brightness}
            display={pct(settings.brightness)}
            track="linear-gradient(90deg,#000,#fff)"
            onChange={(brightness) => setAppearance({ brightness })}
          />
          <Slider
            label="Contrast"
            min={0.5}
            max={1.5}
            step={0.01}
            value={settings.contrast}
            display={pct(settings.contrast)}
            track="linear-gradient(90deg,#777,#fff)"
            onChange={(contrast) => setAppearance({ contrast })}
          />
        </div>
      </section>

      <section className="settings-block">
        <div className="settings-block__label">Accent</div>
        <div className="settings-group">
          <div className="settings-accent">
            <div className="settings-field__text">
              <strong>Highlight color</strong>
              <span>
                Used for highlighted words, selection, file badges, Full auto
                and the send button.
              </span>
            </div>
            <div className="settings-swatches">
              {HIGHLIGHTS.map(([name, value]) => {
                const on =
                  value.toLowerCase() === settings.highlight.toLowerCase();
                const color = value === "grey" ? GREY : value;
                return (
                  <button
                    key={name}
                    type="button"
                    className={`settings-swatch${on ? " is-active" : ""}`}
                    title={name}
                    aria-label={name}
                    aria-pressed={on}
                    style={{
                      background: color,
                      boxShadow: on
                        ? `0 0 0 2px rgb(var(--g-tint, 32 32 37)), 0 0 0 4px ${color}`
                        : undefined,
                    }}
                    onClick={() => setAppearance({ highlight: value })}
                  />
                );
              })}
              <span className="settings-swatches__rule" />
              <label
                className={`settings-custom${knownHighlight ? "" : " is-active"}`}
                title="Custom color"
              >
                <i />
                {highlightHex}
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(highlightHex) ? highlightHex : GREY}
                  aria-label="Custom highlight color"
                  onChange={(event) =>
                    setAppearance({ highlight: event.target.value })
                  }
                />
              </label>
            </div>
          </div>
          <div className="settings-field settings-field--slider">
            <span className="settings-slider__label" title="Washes the backdrop with the accent">
              Tint backdrop
            </span>
            <Slider
              label="Tint backdrop"
              bare
              min={0}
              max={1}
              step={0.01}
              value={settings.colorStrength}
              display={`${Math.round(settings.colorStrength * 100)}%`}
              onChange={(colorStrength) => setAppearance({ colorStrength })}
            />
          </div>
        </div>
      </section>

      <section className="settings-block">
        <div className="settings-block__label">Conversation</div>
        <div className="settings-group">
          <div className="settings-field"><div className="settings-field__text"><strong>Tool row density</strong><span>Spacing between tool calls.</span></div><Segmented options={[{ id: "compact", label: "Compact" }, { id: "comfortable", label: "Comfortable" }]} active={settings.toolDensity} onPick={id => setAppearance({ toolDensity: id as AppearanceSettings["toolDensity"] })} /></div>
          <div className="settings-field"><div className="settings-field__text"><strong>Tool durations</strong><span>Show elapsed time beside tool calls.</span></div><Segmented options={[{ id: "shown", label: "Shown" }, { id: "hidden", label: "Hidden" }]} active={settings.toolDurations ? "shown" : "hidden"} onPick={id => setAppearance({ toolDurations: id === "shown" })} /></div>
          {onShowThinkingChange && <div className="settings-field">
            <div className="settings-field__text">
              <strong>Thinking blocks</strong>
              <span>
                Show the agent's reasoning between replies. Pi's own setting
                is Visible.
              </span>
            </div>
            <Segmented
              options={[
                { id: "hidden", label: "Hidden" },
                { id: "shown", label: "Shown" },
              ]}
              active={showThinking ? "shown" : "hidden"}
              onPick={(id) => onShowThinkingChange(id === "shown")}
            />
          </div>}
        </div>
      </section>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          addImage(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </>
  );
}

interface Tile {
  id: string;
  name: string;
  desc: string;
  swatch: string;
  photo: boolean;
  active: boolean;
  pick: () => void;
  remove?: () => void;
}

function describe(settings: AppearanceSettings): {
  name: string;
  cat: Cat;
  swatch: string;
  photo: boolean;
} {
  const wall = wallpaperByName(settings.wallpaper);
  if (wall)
    return {
      name: wall.name,
      cat: "Scenic",
      swatch: wall.thumb,
      photo: true,
    };
  if (
    settings.customImage &&
    (settings.wallpaper === CUSTOM_WALLPAPER ||
      settings.scene === CUSTOM_SCENE)
  )
    return {
      name: "Custom",
      cat: "Yours",
      swatch: settings.customImage,
      photo: true,
    };
  const index = sceneIndex(settings.scene);
  if (index >= 0)
    return {
      name: SCENES[index][0],
      cat: catForScene(index),
      swatch: SCENES[index][2],
      photo: false,
    };
  return {
    name: "None",
    cat: "Scenic",
    swatch: "linear-gradient(135deg,#f4f1e9 50%,#12110f 50%)",
    photo: false,
  };
}

function catForScene(index: number): Cat {
  if (SCENE_GROUPS[0].indices.includes(index)) return "Day & Night";
  if (SCENE_GROUPS[1].indices.includes(index)) return "Getaways";
  return "Abstract";
}

function countFor(cat: Cat): number {
  if (cat === "Scenic") return WALLPAPERS.length;
  if (cat === "Day & Night") return SCENE_GROUPS[0].indices.length;
  if (cat === "Getaways") return SCENE_GROUPS[1].indices.length;
  if (cat === "Abstract") return SCENE_GROUPS[2].indices.length;
  return 0;
}

function photoWins(settings: AppearanceSettings): boolean {
  return (
    wallpaperByName(settings.wallpaper) != null ||
    (settings.wallpaper === CUSTOM_WALLPAPER && !!settings.customImage)
  );
}

function tilesFor(cat: Cat, settings: AppearanceSettings): Tile[] {
  if (cat === "Scenic")
    return WALLPAPERS.map((wallpaper) => ({
      id: wallpaper.name,
      name: wallpaper.name,
      desc: wallpaper.name,
      swatch: wallpaper.thumb,
      photo: true,
      active: settings.wallpaper === wallpaper.name,
      pick: () =>
        setAppearance({ wallpaper: wallpaper.name, background: "glass" }),
    }));
  if (cat === "Yours") {
    if (!settings.customImage) return [];
    const active =
      settings.wallpaper === CUSTOM_WALLPAPER ||
      settings.scene === CUSTOM_SCENE;
    return [
      {
        id: "custom",
        name: "Custom",
        desc: "Your uploaded image",
        swatch: settings.customImage,
        photo: true,
        active,
        pick: () =>
          setAppearance({
            wallpaper: CUSTOM_WALLPAPER,
            background: "glass",
          }),
        remove: () =>
          setAppearance({
            customImage: null,
            wallpaper:
              settings.wallpaper === CUSTOM_WALLPAPER
                ? NO_WALLPAPER
                : settings.wallpaper,
            scene:
              settings.scene === CUSTOM_SCENE ? STATIC_SCENE : settings.scene,
          }),
      },
    ];
  }
  const group =
    cat === "Day & Night" ? SCENE_GROUPS[0] : cat === "Getaways" ? SCENE_GROUPS[1] : SCENE_GROUPS[2];
  const showing = !photoWins(settings);
  return group.indices.map((index) => ({
    id: SCENES[index][0],
    name: SCENES[index][0],
    desc: SCENES[index][1],
    swatch: SCENES[index][2],
    photo: false,
    active: showing && settings.scene === SCENES[index][0],
    pick: () =>
      setAppearance({ scene: SCENES[index][0], background: "glass" }),
  }));
}

function Toggle({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    />
  );
}

function Segmented({
  options,
  active,
  onPick,
}: {
  options: { id: string; label: string }[];
  active: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="seg-control seg-control--inline" role="group">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`seg-control__option${option.id === active ? " is-active" : ""}`}
          aria-pressed={option.id === active}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  display,
  track,
  bare,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  track?: string;
  bare?: boolean;
  onChange: (value: number) => void;
}) {
  const pctValue = Math.max(
    0,
    Math.min(100, ((value - min) / (max - min)) * 100),
  );
  const control = (
    <div className="settings-slider__track">
      <div
        className="settings-slider__rail"
        style={
          track
            ? ({ "--slider-track": track } as React.CSSProperties)
            : undefined
        }
      />
      {!track && (
        <div
          className="settings-slider__fill"
          style={{ width: `${pctValue}%` }}
        />
      )}
      <div
        className="settings-slider__knob"
        style={{ left: `${pctValue}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
  if (bare)
    return (
      <>
        {control}
        <span className="settings-slider__value">{display}</span>
      </>
    );
  return (
    <div className="settings-slider">
      <span className="settings-slider__label">{label}</span>
      {control}
      <span className="settings-slider__value">{display}</span>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
