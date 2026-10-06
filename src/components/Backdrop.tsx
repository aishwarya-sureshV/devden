import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { BACKDROP_FRAGMENT_SHADER } from "../lib/backdropShader";
import { samplePhotoTone, sampleSurfaceTone } from "../lib/backdropTone";
import {
  canvasFilter,
  activePhoto,
  getAppearance,
  isGlass,
  paletteColors,
  photoFilter,
  sceneIndex,
  subscribeAppearance,
  type AppearanceSettings,
} from "../lib/appearance";

/**
 * The backdrop is one of two kinds, switched by the appearance store:
 *
 *  • Shader scene — one WebGL fragment shader renders all 20 themes, read
 *    from the store each frame so live slider updates apply without
 *    rebuilding the context. Rendered at 0.6× devicePixelRatio (capped at
 *    2×): the scenes are soft fields, not line art, so the resolution
 *    budget goes to the blur.
 *
 *  • Photo wallpaper — the bundled Scenic backgrounds set or a custom
 *    upload. The drift (slow zoom + pan plus a warm light sweep every 14s)
 *    is one CSS keyframe scaled by a --mi custom property; parallax is a
 *    single pointermove handler translating the photo wrapper. The OS
 *    "Reduce motion" setting disables all motion regardless of the user's
 *    intensity choice. Blur lives on the photo itself, same as the old
 *    canvas filter, so panes never read as overlays.
 */
export function Backdrop() {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance);
  // Motion only while DevDen is the window in use. Anything moving under the
  // frosted panes re-blurs them every frame (~30% GPU, measured), and a
  // window left behind other apps paid that all day.
  useEffect(() => {
    const apply = () =>
      document.documentElement.classList.toggle(
        "is-window-idle",
        document.hidden || !document.hasFocus(),
      );
    // Deferred a tick: on pointerdown, focus hasn't moved in yet.
    const sync = () => setTimeout(apply);
    apply();
    // focus/blur alone miss a click into an embedded or just-raised window.
    const events = ["focus", "blur", "focusin", "pointerdown", "visibilitychange"];
    for (const name of events) window.addEventListener(name, sync, true);
    return () => {
      for (const name of events) window.removeEventListener(name, sync, true);
    };
  }, []);
  useEffect(() => {
    if ((settings.background ?? "glass") !== "glass")
      document.body.style.removeProperty("--composer-tone");
  }, [settings.background]);
  // Black, White, Cream and Aurora paint their own field. Glass keeps the
  // photo or shader that is already selected.
  if ((settings.background ?? "glass") !== "glass") return null;
  const photo = activePhoto(settings);
  if (photo) return <PhotoBackdrop url={photo} settings={settings} />;
  return <SceneCanvas settings={settings} />;
}

function PhotoBackdrop({
  url,
  settings,
}: {
  url: string;
  settings: AppearanceSettings;
}) {
  const parallaxRef = useRef<HTMLDivElement>(null);

  const reduce =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Intensity factor: 60 is the design's default look, 0 is no motion.
  const mi = Math.max(0, Math.min(100, settings.wallpaperIntensity)) / 60;
  const animate = !reduce && settings.wallpaperMotion !== "still" && mi > 0;
  // The loop lengthens as intensity drops, floor 0.4× speed.
  const duration = `${Math.round(36 / Math.max(0.4, mi))}s`;

  useEffect(() => {
    let cancel = false;
    const filter = photoFilter(settings);
    samplePhotoTone(url, filter).then((tone) => {
      if (!cancel) document.body.style.setProperty("--composer-tone", tone);
    });
    return () => {
      cancel = true;
    };
  }, [
    url,
    settings.hue,
    settings.saturation,
    settings.brightness,
    settings.contrast,
  ]);

  useEffect(() => {
    if (reduce || settings.wallpaperMotion !== "drift-parallax") return;
    const onMove = (event: PointerEvent) => {
      const el = parallaxRef.current;
      if (!el) return;
      const dx = event.clientX / window.innerWidth - 0.5;
      const dy = event.clientY / window.innerHeight - 0.5;
      el.style.transform = `translate(${(dx * -36 * mi).toFixed(1)}px,${(dy * -24 * mi).toFixed(1)}px)`;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [settings.wallpaperMotion, mi, reduce]);

  const photoStyle: CSSProperties & Record<string, string> = {
    "--mi": String(mi),
    "--wb-dur": duration,
    backgroundImage: `url("${url}")`,
    filter: `blur(${settings.blur}px) ${photoFilter(settings)}`,
  };
  photoStyle["--wb-blur"] = `${settings.blur}px`;

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <div className="backdrop__parallax" ref={parallaxRef}>
          <div
            className={`backdrop__photo${animate ? " is-drifting" : ""}`}
            style={photoStyle}
          />
        </div>
        {animate && (
          <div
            className="backdrop__glint"
            style={{ opacity: Math.min(1, mi) }}
          />
        )}
      </div>
      {/* Dark overlay keeps the frosted panels readable over any photo. */}
      <div className="backdrop__overlay" aria-hidden="true" />
    </>
  );
}

function SceneCanvas({ settings }: { settings: AppearanceSettings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glass = isGlass();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) return;
    gl.getExtension("OES_standard_derivatives");

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };
    const program = gl.createProgram();
    const vertex = compile(
      gl.VERTEX_SHADER,
      "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}",
    );
    const fragment = compile(gl.FRAGMENT_SHADER, BACKDROP_FRAGMENT_SHADER);
    if (!program || !vertex || !fragment) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ["R", "T", "M", "I", "F", "Lm", "Hs", "Hd", "P1", "P2"])
      u[name] = uniform(name);

    // Palette hue direction in IQ chroma space, matching the mockup's tint().
    const directionOf = (hex: string): [number, number] => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const i = 0.596 * r - 0.274 * g - 0.322 * b;
      const q = 0.211 * r - 0.523 * g + 0.312 * b;
      const len = Math.hypot(i, q) || 1;
      return [i / len, q / len];
    };

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let t = parseFloat(localStorage.getItem("devden.backdrop-t") || "20");
    let last = performance.now();
    let acc = 0;
    let current = sceneIndex();
    let fade = 0;
    let saved = 0;
    let dead = false;
    let raf = 0;
    let nextTone = 0;
    let lastTone = "";

    const loop = (now: number) => {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (document.documentElement.classList.contains("is-window-idle"))
        return;
      acc += dt;
      if (acc < 1 / 30) return;
      const step = acc;
      acc = 0;

      const s = getAppearance();
      if (activePhoto(s) !== null) {
        // A wallpaper took over — stop drawing (the canvas is hidden).
        return;
      }
      const want = sceneIndex();
      if (want === current) {
        fade = Math.min(1, fade + step * 1.1);
      } else {
        fade -= step * 2.5;
        if (fade <= 0) {
          fade = 0;
          current = want;
        }
      }
      if (current < 0) return; // static theme: nothing to draw
      t += step * (reduce || !s.motion ? 0 : s.speed);
      if ((saved += step) > 2) {
        saved = 0;
        localStorage.setItem("devden.backdrop-t", t.toFixed(2));
      }

      const scale = Math.min(devicePixelRatio || 1, 2) * 0.6;
      const width = Math.round(innerWidth * scale);
      const height = Math.round(innerHeight * scale);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(u.R, width, height);
      gl.uniform1f(u.T, t);
      gl.uniform1f(u.M, current);
      gl.uniform1f(u.I, s.intensity);
      gl.uniform1f(u.F, fade * fade * (3 - 2 * fade));
      const colors = paletteColors(s.palette);
      if (colors) {
        const [d0, d1, d2] = colors.map(directionOf);
        gl.uniform2f(u.Hd, d0[0], d0[1]);
        gl.uniform2f(u.P1, d1[0], d1[1]);
        gl.uniform2f(u.P2, d2[0], d2[1]);
        gl.uniform1f(u.Hs, Math.max(0.01, s.colorStrength));
      } else {
        gl.uniform1f(u.Hs, 0);
      }
      gl.uniform1f(u.Lm, s.mode === "light" ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (now >= nextTone && activePhoto(s) === null && sceneIndex() >= 0) {
        nextTone = now + 1200;
        const tone = sampleSurfaceTone(canvas, photoFilter(s));
        if (tone && tone !== lastTone) {
          lastTone = tone;
          document.body.style.setProperty("--composer-tone", tone);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  const style: CSSProperties = {
    position: "fixed",
    // Bleed past the viewport so the blur doesn't fade the window edges.
    inset: -2 * settings.blur,
    display: "block",
    zIndex: 0,
    filter: canvasFilter(settings),
  };
  // Static theme: keep the canvas in the DOM (context stays warm) but hidden.
  if (!glass) style.display = "none";
  return <canvas ref={canvasRef} aria-hidden="true" style={style} />;
}
