import { useRef, useState, useSyncExternalStore } from "react";
import {
  CUSTOM_SCENE,
  CUSTOM_WALLPAPER,
  HIGHLIGHTS,
  NO_WALLPAPER,
  PALETTES,
  SCENES,
  SCENE_GROUPS,
  STATIC_SCENE,
  WALLPAPERS,
  getAppearance,
  intensityLabel,
  photoBackdrop,
  sceneIndex,
  sceneSwatch,
  setAppearance,
  setCustomImage,
  subscribeAppearance,
  type AppearanceSettings,
  type WallpaperMotion,
} from "../lib/appearance";

const TABS = ["Backdrop", "Color", "Glass"] as const;

/**
 * Wallpaper + motion, palette adjust, and glass tuning, shown as sub-tabs
 * under Settings → Appearance.
 */
export function SettingsAppearance() {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Backdrop");
  return (
    <section className="settings-card settings-appearance">
      <div
        className="settings-tabs settings-tabs--sub"
        role="tablist"
        aria-label="Appearance sections"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "is-active" : ""}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
        {tab === "Color" && (
          <button
            type="button"
            className="settings-appearance__reset"
            onClick={() =>
              setAppearance({
                hue: 0,
                saturation: 1,
                brightness: 1,
                contrast: 1,
              })
            }
          >
            Reset adjustments
          </button>
        )}
      </div>
      {tab === "Backdrop" && <BackdropTab settings={settings} />}
      {tab === "Color" && <ColorTab settings={settings} />}
      {tab === "Glass" && <GlassTab settings={settings} />}
      <p className="settings-hint">[ ] cycle backdrop</p>
    </section>
  );
}

function BackdropTab({ settings }: { settings: AppearanceSettings }) {
  const current = sceneIndex();
  const fileRef = useRef<HTMLInputElement>(null);
  const custom = settings.customImage;
  const pickFile = () => fileRef.current?.click();
  const photo = photoBackdrop(settings) !== null;
  return (
    <>
      <div className="settings-section-label">MOTION</div>
      <div className="settings-panel">
        {photo ? (
          <>
            <div className="settings-row">
              <span className="settings-row__label">Wallpaper motion</span>
              <Segmented
                options={[
                  { id: "still", label: "Still" },
                  { id: "drift", label: "Drift" },
                  { id: "drift-parallax", label: "Drift + parallax" },
                ]}
                active={settings.wallpaperMotion}
                onPick={(id) =>
                  setAppearance({ wallpaperMotion: id as WallpaperMotion })
                }
              />
            </div>
            <Slider
              label="Intensity"
              min={0}
              max={100}
              step={1}
              value={settings.wallpaperIntensity}
              display={`${intensityLabel(settings.wallpaperIntensity)} · ${settings.wallpaperIntensity}`}
              onChange={(wallpaperIntensity) =>
                setAppearance({ wallpaperIntensity })
              }
            />
            <p className="settings-hint">
              Intensity scales the drift zoom and pan, the loop speed, the light
              sweep and the parallax travel. The OS <q>Reduce motion</q> setting
              overrides all of it.
            </p>
          </>
        ) : (
          <>
            <div className="settings-row">
              <span className="settings-row__label">Animate backdrop</span>
              <Toggle
                on={settings.motion}
                onToggle={() => setAppearance({ motion: !settings.motion })}
              />
            </div>
            <Slider
              label="Speed"
              min={0}
              max={3}
              step={0.1}
              value={settings.speed}
              display={`${settings.speed.toFixed(1)}×`}
              onChange={(speed) => setAppearance({ speed })}
            />
            <Slider
              label="Intensity"
              min={0.3}
              max={1.8}
              step={0.05}
              value={settings.intensity}
              display={pct(settings.intensity)}
              onChange={(intensity) => setAppearance({ intensity })}
            />
          </>
        )}
      </div>
      <WallpaperGallery
        settings={settings}
        custom={custom}
        onPickFile={pickFile}
      />
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
      {custom && (
        <div className="settings-row">
          <span className="settings-row__label">Custom image</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="settings-appearance__reset"
              onClick={pickFile}
            >
              Replace
            </button>
            <button
              type="button"
              className="settings-appearance__reset"
              onClick={() =>
                setAppearance({
                  customImage: null,
                  wallpaper:
                    settings.wallpaper === CUSTOM_WALLPAPER
                      ? NO_WALLPAPER
                      : settings.wallpaper,
                  scene:
                    settings.scene === CUSTOM_SCENE
                      ? STATIC_SCENE
                      : settings.scene,
                })
              }
            >
              Remove
            </button>
          </span>
        </div>
      )}
      <SceneGallery
        label="THEME"
        tiles={[
          {
            name: STATIC_SCENE,
            mood: "Original solid dark & light",
            swatch: sceneSwatch(STATIC_SCENE),
            active:
              settings.scene === STATIC_SCENE &&
              settings.wallpaper === NO_WALLPAPER,
            pick: () => setAppearance({ scene: STATIC_SCENE }),
          },
          {
            name: CUSTOM_SCENE,
            mood: custom ? "Your uploaded image" : "Click to upload an image",
            swatch:
              custom ?? "linear-gradient(135deg,#262631 50%,#3f3f4d 50%),none",
            active: settings.scene === CUSTOM_SCENE,
            pick: () =>
              custom ? setAppearance({ scene: CUSTOM_SCENE }) : pickFile(),
          },
        ]}
      />
      {SCENE_GROUPS.map((group) => (
        <SceneGallery
          key={group.label}
          label={group.label.toUpperCase()}
          tiles={group.indices.map((index) => ({
            name: SCENES[index][0],
            mood: SCENES[index][1],
            swatch: SCENES[index][2],
            active: index === current,
            pick: () => setAppearance({ scene: SCENES[index][0] }),
          }))}
        />
      ))}
    </>
  );
}

/** Scenic backgrounds: the bundled photos, plus custom and the solid theme. */
function WallpaperGallery({
  settings,
  custom,
  onPickFile,
}: {
  settings: AppearanceSettings;
  custom: string | null;
  onPickFile: () => void;
}) {
  return (
    <>
      <div className="settings-section-label">SCENIC BACKGROUNDS</div>
      <div className="settings-gallery">
        <button
          type="button"
          className={`settings-scene${
            settings.wallpaper === NO_WALLPAPER &&
            settings.scene === STATIC_SCENE
              ? " is-active"
              : ""
          }`}
          onClick={() => setAppearance({ wallpaper: NO_WALLPAPER })}
        >
          <div
            className="settings-scene__swatch"
            style={{
              background: "linear-gradient(135deg,#f4f1e9 50%,#12110f 50%)",
            }}
          />
          <div className="settings-scene__name">{NO_WALLPAPER}</div>
          <div className="settings-scene__mood">Original solid theme</div>
        </button>
        {WALLPAPERS.map((wallpaper) => (
          <button
            key={wallpaper.name}
            type="button"
            className={`settings-scene${settings.wallpaper === wallpaper.name ? " is-active" : ""}`}
            onClick={() => setAppearance({ wallpaper: wallpaper.name })}
          >
            <div
              className="settings-scene__swatch settings-scene__swatch--photo"
              style={{
                backgroundImage: `url("${wallpaper.thumb}")`,
              }}
            />
            <div className="settings-scene__name">{wallpaper.name}</div>
          </button>
        ))}
        <button
          type="button"
          className={`settings-scene${settings.wallpaper === CUSTOM_WALLPAPER ? " is-active" : ""}`}
          onClick={() =>
            custom
              ? setAppearance({ wallpaper: CUSTOM_WALLPAPER })
              : onPickFile()
          }
        >
          <div
            className="settings-scene__swatch"
            style={{
              background:
                custom ?? "linear-gradient(135deg,#262631 50%,#3f3f4d 50%)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
          <div className="settings-scene__name">{CUSTOM_WALLPAPER}</div>
          <div className="settings-scene__mood">
            {custom ? "Your uploaded image" : "Click to upload an image"}
          </div>
        </button>
      </div>
    </>
  );
}

function ColorTab({ settings }: { settings: AppearanceSettings }) {
  const highlightSwatch = (value: string) =>
    value === "grey"
      ? "linear-gradient(135deg,#3a3a42 50%,#d2d0da 50%)"
      : value;
  return (
    <>
      <div className="settings-section-label">HIGHLIGHTED WORDS</div>
      <div className="settings-palettes">
        {HIGHLIGHTS.map(([name, value]) => (
          <button
            key={name}
            type="button"
            title={name}
            className={`settings-palette${settings.highlight === value ? " is-active" : ""}`}
            onClick={() => setAppearance({ highlight: value })}
          >
            <span
              className="settings-palette__swatch"
              style={{ background: highlightSwatch(value) }}
            />
            {name}
          </button>
        ))}
      </div>
      <p className="settings-hint">
        The picked color replaces every amber in the app — highlighted words,
        the New session and Auto mode overlays, modified-file badges, js file
        dots. Amber is the project&apos;s original accent amber; Gold and Bronze
        are its original yellow and highlight tones; Grey is the neutral design
        chip.
      </p>
      <div className="settings-section-label">PALETTE</div>
      <div className="settings-palettes">
        {PALETTES.map(([name, colors]) => (
          <button
            key={name}
            type="button"
            title={name}
            className={`settings-palette${settings.palette === name ? " is-active" : ""}`}
            onClick={() => setAppearance({ palette: name })}
          >
            <span
              className="settings-palette__swatch"
              style={{
                background: colors
                  ? `conic-gradient(${colors[0]},${colors[1]},${colors[2]},${colors[0]})`
                  : "conic-gradient(#ff8a65,#e8d86a,#5fd49a,#4aa3ff,#a585ff,#ff8a65)",
              }}
            />
            {name}
          </button>
        ))}
      </div>
      <div className="settings-panel">
        <Slider
          label="Palette strength"
          min={0}
          max={1}
          step={0.01}
          value={settings.colorStrength}
          display={pct(settings.colorStrength)}
          onChange={(colorStrength) => setAppearance({ colorStrength })}
        />
      </div>
      <p className="settings-hint">
        Palette tints the shader scenes; the adjust sliders below re-color both
        the scenes and the scenic wallpapers.
      </p>
      <div className="settings-section-label">ADJUST</div>
      <div className="settings-panel">
        <Slider
          label="Hue"
          min={-180}
          max={180}
          step={1}
          value={settings.hue}
          display={`${Math.round(settings.hue)}°`}
          track="linear-gradient(90deg,#3fb6ff,#8a5cff,#ff5fae,#ff6b4a,#ffc34a,#6bd46b,#3fd4c4,#3fb6ff)"
          onChange={(hue) => setAppearance({ hue })}
        />
        <Slider
          label="Saturation"
          min={0}
          max={2}
          step={0.01}
          value={settings.saturation}
          display={pct(settings.saturation)}
          track="linear-gradient(90deg,#8d8d93,#ff7a59 50%,#ff2d6f)"
          onChange={(saturation) => setAppearance({ saturation })}
        />
        <Slider
          label="Brightness"
          min={0.4}
          max={1.6}
          step={0.01}
          value={settings.brightness}
          display={pct(settings.brightness)}
          track="linear-gradient(90deg,#0b0b0f,#8d8d93 50%,#fbfbfd)"
          onChange={(brightness) => setAppearance({ brightness })}
        />
        <Slider
          label="Contrast"
          min={0.5}
          max={1.5}
          step={0.01}
          value={settings.contrast}
          display={pct(settings.contrast)}
          track="linear-gradient(90deg,#6f6f76,#6f6f76 30%,#000 50%,#fff 50%)"
          onChange={(contrast) => setAppearance({ contrast })}
        />
      </div>
    </>
  );
}

function GlassTab({ settings }: { settings: AppearanceSettings }) {
  return (
    <>
      <div className="settings-section-label">PANES</div>
      <div className="settings-panel">
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
          step={0.02}
          value={settings.tint}
          display={pct(settings.tint)}
          onChange={(tint) => setAppearance({ tint })}
        />
      </div>
      <p className="settings-hint">
        Blur and tint cover the whole workbench while a theme or a scenic
        photo is on. Hue, saturation, brightness and contrast recolor both.
      </p>
    </>
  );
}

/* ---------- shared controls ---------- */

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`settings-toggle${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label="Toggle"
      onClick={onToggle}
    />
  );
}

function SceneGallery({
  label,
  tiles,
}: {
  label: string;
  tiles: {
    name: string;
    mood: string;
    swatch: string;
    active: boolean;
    pick: () => void;
  }[];
}) {
  return (
    <>
      <div className="settings-section-label">{label}</div>
      <div className="settings-gallery">
        {tiles.map((tile) => (
          <button
            key={tile.name}
            type="button"
            className={`settings-scene${tile.active ? " is-active" : ""}`}
            onClick={tile.pick}
          >
            <div
              className="settings-scene__swatch"
              style={{ background: tile.swatch }}
            />
            <div className="settings-scene__name">{tile.name}</div>
            <div className="settings-scene__mood">{tile.mood}</div>
          </button>
        ))}
      </div>
    </>
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
    <div className="seg-control" role="group">
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
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  track?: string;
  onChange: (value: number) => void;
}) {
  const pctValue = Math.max(
    0,
    Math.min(100, ((value - min) / (max - min)) * 100),
  );
  return (
    <div className="settings-slider">
      <span className="settings-slider__label">{label}</span>
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
      <span className="settings-slider__value">{display}</span>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
