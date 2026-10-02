/** Deep shade of a backdrop's dominant color, for the prompt box.
 *  Flat black reads as a hole; the old white frost reads as milk. */

const FALLBACK = "rgb(17 18 20)";

/** Average of the pixels in the most common hue family (12 bins of 30°).
 *  Near-gray pixels don't vote, so a gray sky can't outvote green trees. */
export function dominantRgb(
  data: Uint8ClampedArray,
): [number, number, number] | null {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const { h, s } = rgbToHsl(r, g, b);
    if (s < 0.08) continue;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.w += s;
    bin.r += r * s;
    bin.g += g * s;
    bin.b += b * s;
  }
  const top = bins.reduce((m, x) => (x.w > m.w ? x : m));
  if (top.w === 0) return null;
  return [top.r / top.w, top.g / top.w, top.b / top.w];
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** Same hue as the dominant color, muted toward a grayish black: enough
 *  color that each wallpaper reads differently (7.5%/0.22 made them all the
 *  same gray-black), not so much that the glass turns olive or teal. */
export function deepShade(r: number, g: number, b: number): string {
  const { h, s } = rgbToHsl(r, g, b);
  if (s < 0.06) return FALLBACK;
  const [R, G, B] = hslToRgb(h, Math.min(0.3, s * 0.8), 0.11);
  return `rgb(${R} ${G} ${B})`;
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

/** Deep shade of the dominant color in `source` (photo or scene canvas) after the backdrop's color filter. */
export function sampleSurfaceTone(
  source: CanvasImageSource,
  filter: string,
): string | null {
  if (typeof document === "undefined") return null;
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = 32;
    scratch.height = 32;
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  const ctx = scratchCtx;
  if (!ctx) return null;
  ctx.clearRect(0, 0, 32, 32);
  ctx.filter = filter || "none";
  ctx.drawImage(source, 0, 0, 32, 32);
  ctx.filter = "none";
  const avg = dominantRgb(ctx.getImageData(0, 0, 32, 32).data);
  if (!avg) return null;
  return deepShade(avg[0], avg[1], avg[2]);
}

export async function samplePhotoTone(
  url: string,
  filter: string,
): Promise<string> {
  try {
    const img = new Image();
    img.decoding = "async";
    if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("backdrop image"));
      img.src = url;
    });
    return sampleSurfaceTone(img, filter) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
