/** Colored glyph before a file chip's path. Not tied to the language: each
 *  file name hashes to one glyph from a mixed pool, so different files in a
 *  reply get different icons, and the same file always gets the same one. */
const POOL: Array<[color: string, d: string]> = [
  ["#6ea8fe", "M8 1.5 14 5v6l-6 3.5L2 11V5z M2 5l6 3.5L14 5 M8 8.5v6"], // cube
  ["#e685b5", "M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.2l-3.9 2.2.9-4.4-3.3-3 4.4-.5z"], // star
  ["#e8b45a", "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"], // bolt
  ["#7cc99a", "M13.5 2.5C6 2.5 2.5 6 2.5 13.5 10 13.5 13.5 10 13.5 2.5z M2.5 13.5l7-7"], // leaf
  ["#b59cf5", "M4.5 2h7l3 4-6.5 8.5L1.5 6z M1.5 6h13 M6 6l2 8.5L10 6"], // gem
  ["#5fd0c5", "M8 1.5 14.5 5 8 8.5 1.5 5z M1.5 8 8 11.5 14.5 8 M1.5 11 8 14.5 14.5 11"], // layers
  ["#f08a6c", "M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.5 3.5l2.5 2.5M10 10l2.5 2.5M12.5 3.5 10 6M6 10l-2.5 2.5"], // spark
  ["#8fc7f0", "M8 1.5 13.6 4.75v6.5L8 14.5l-5.6-3.25v-6.5z M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5"], // hex nut
  ["#d6d36a", "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13 M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6"], // ring
  ["#f2a65a", "M2 3.5h5v5H2z M9 3.5h5v5H9z M5.5 10.5h5v4h-5z"], // blocks
];

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function FileIcon({ path }: { path: string }) {
  const name = path.replace(/:\d+(?::\d+)?$/, "");
  const [color, d] = POOL[hash(name) % POOL.length];
  return (
    <svg
      className="md-chip-icon"
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill={color}
      fillOpacity={0.2}
      stroke={color}
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
