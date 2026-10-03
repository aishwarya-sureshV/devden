/** Minimal inline icons matching the deepseek composer glyph set. */

export function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function IconUpload({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 10.5V2.8M4.9 5.9 8 2.8l3.1 3.1" />
      <path d="M3 9.5v2.2A1.3 1.3 0 0 0 4.3 13h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5" />
    </svg>
  );
}

export function IconCommand({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.4 3.5H4.2a2 2 0 0 0 0 4h7.6a2 2 0 1 1 0 4h-1.2" />
      <path d="m4.2 9.5-2 2 2 2M11.8 1.5l2 2-2 2" />
    </svg>
  );
}

export function IconFile({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3" />
    </svg>
  );
}

/** Glyph drawn inside the page, per `fileKind()`; color comes from CSS `--k`. */
const FILE_KIND_GLYPH: Record<string, string> = {
  tsx: "m6.4 8.6-1.6 1.7 1.6 1.7M9.6 8.6l1.6 1.7-1.6 1.7",
  jsx: "m6.4 8.6-1.6 1.7 1.6 1.7M9.6 8.6l1.6 1.7-1.6 1.7",
  ts: "M5.2 8.6h3M6.7 8.6v3.6M11 8.9c-.4-.4-1.8-.5-1.8.4 0 1 1.9.7 1.9 1.8 0 .9-1.5 1-2 .5",
  js: "M7.4 8.6v2.6c0 1-1.4 1.1-1.8.5M11 8.9c-.4-.4-1.8-.5-1.8.4 0 1 1.9.7 1.9 1.8 0 .9-1.5 1-2 .5",
  css: "M6.6 8.4 6 12.4M9.4 8.4 8.8 12.4M5.3 9.6h5.4M5 11.2h5.4",
  test: "m5.4 10.4 1.6 1.6 3.4-3.4",
  json: "M6.6 8.4c-.9 0-.9.4-.9 1v.4l-.5.5.5.5v.4c0 .6 0 1 .9 1M9.4 8.4c.9 0 .9.4.9 1v.4l.5.5-.5.5v.4c0 .6 0 1-.9 1",
  md: "M5.2 8.8h5.6M5.2 10.4h5.6M5.2 12h3.4",
};
FILE_KIND_GLYPH.mjs = FILE_KIND_GLYPH.cjs = FILE_KIND_GLYPH.js;
FILE_KIND_GLYPH.scss = FILE_KIND_GLYPH.css;
FILE_KIND_GLYPH.yml = FILE_KIND_GLYPH.yaml = FILE_KIND_GLYPH.toml = FILE_KIND_GLYPH.json;
FILE_KIND_GLYPH.html = FILE_KIND_GLYPH.md;

/** Tinted page with a per-type glyph (tsx `<>`, css `#`, json `{}`, …). */
export function IconFileKind({ kind, size = 16 }: { kind: string; size?: number }) {
  const glyph = FILE_KIND_GLYPH[kind];
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 1.6h5.6l3.4 3.4v9.4h-9z" fill="currentColor" fillOpacity="0.16" />
      <path d="M9.1 1.6V5h3.4" />
      {glyph && <path d={glyph} />}
    </svg>
  );
}

export function IconFolder({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44l.84.84a1.5 1.5 0 0 0 1.06.44h3.44A1.5 1.5 0 0 1 14 6.22v5.28a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  );
}

export function IconCube({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8L8 1.5Z" />
      <path d="M8 8 14 4.8M8 8v6.5M8 8 2 4.8" />
    </svg>
  );
}

export function IconChevronDown({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="m3.5 5.5 3.5 3.5 3.5-3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** deepseek fish logo approximation (used in the hero headline). */
export function FishLogo({ size = 34 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 34 34"
      width={size}
      height={size}
      aria-hidden
      fill="currentColor"
    >
      <path d="M24.5 6c-5.6.3-10.3 3.3-13 7.5-1 1.6-1.8 3-3.4 3.6-1.3.5-2.9.2-4.1 1-1 .7-1.3 2.1-.8 3.2.7-.9 1.9-1.3 2.9-1 1.4.4 2.3 1.8 2.7 3.2.4 1.4.4 3 1.2 4.2.7 1 2 1.5 3 1.1-.4-1-.3-2.2.2-3.1.7-1.2 2-1.8 3.2-2.3 3.2-1.2 6.2-3.5 7.9-6.7 1.7-3.2 2-7 .7-10.2-.2-.5-.4-.9-.5-.5Z" />
      <circle cx="22.8" cy="12.4" r="1.4" fill="var(--dsw-alias-bg-base)" />
    </svg>
  );
}

export function IconArrowUp({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconStop({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  );
}

export function IconPanel({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="2" />
      <path d="M5.5 2.5v11" />
    </svg>
  );
}

export function IconColumns({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="2" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

/** Three columns: the header's kanban toggle. */
export function IconKanban({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinejoin="round"
    >
      <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
      <rect x="6.4" y="2.5" width="3.2" height="7" rx="1" />
      <rect x="10.8" y="2.5" width="3.2" height="9" rx="1" />
    </svg>
  );
}

export function IconOpenTab({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5h4v4M13.5 2.5 8 8" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

export function IconNewChat({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.4 7.5v4.1a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8V4.4a1.8 1.8 0 0 1 1.8-1.8h4.1" />
      <path d="M10.2 2.8h3v3M8.8 7.2l4.4-4.4" />
    </svg>
  );
}

export function IconSun({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </svg>
  );
}

export function IconMoon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.9 10.3A5.6 5.6 0 0 1 5.7 3.1a5.6 5.6 0 1 0 7.2 7.2Z" />
    </svg>
  );
}

export function IconDots({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="currentColor"
    >
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
    </svg>
  );
}

export function IconArchive({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.2 4.2h11.6v8.2a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.2Z" />
      <path d="M1.6 2.3h12.8v2H1.6zM6 7.2h4" />
    </svg>
  );
}

export function IconRestore({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.2 5.3A5.3 5.3 0 1 1 2.9 10" />
      <path d="M3.2 2.2v3.1H.2M8 4.8v3.5l2.4 1.4" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4.2h11M6 1.9h4l.7 2.3H5.3L6 1.9ZM4.2 4.2l.6 9.2h6.4l.6-9.2M6.7 7v3.7M9.3 7v3.7" />
    </svg>
  );
}

export function IconSearch({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      <circle cx="6.8" cy="6.8" r="4.5" />
      <path d="m10.2 10.2 3.4 3.4" />
    </svg>
  );
}

export function IconFilter({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 3.5h11L9.5 8.4v4.1l-3 1.5V8.4z" />
    </svg>
  );
}

export function IconFolderPlus({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 5A1.5 1.5 0 0 1 3.5 3.5h2.3l1.3 1.4h5.4A1.5 1.5 0 0 1 14 6.4v5.1a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V5Z" />
      <path d="M10.5 7v4M8.5 9h4" />
    </svg>
  );
}

export function IconDownload({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.2v7.4M5.2 7.2 8 10l2.8-2.8" />
      <path d="M3 11.2v1.4A1.4 1.4 0 0 0 4.4 14h7.2a1.4 1.4 0 0 0 1.4-1.4v-1.4" />
    </svg>
  );
}

export function IconPlay({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="currentColor"
    >
      <path d="M5.2 3.3v9.4L13.2 8Z" />
    </svg>
  );
}

export function IconCopy({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      <rect x="5.2" y="5.2" width="8.1" height="8.1" rx="1.4" />
      <path d="M10.8 5.2V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.6a1.3 1.3 0 0 0 1.3 1.3h1.3" />
    </svg>
  );
}

export function IconCheck({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 8.2 3.1 3.1L13 4.7" />
    </svg>
  );
}

export function IconFork({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="3.2" r="1.5" />
      <circle cx="12" cy="3.2" r="1.5" />
      <circle cx="8" cy="12.8" r="1.5" />
      <path d="M4 4.7v1.1A3.2 3.2 0 0 0 7.2 9H8m4-4.3v1.1A3.2 3.2 0 0 1 8.8 9H8v2.3" />
    </svg>
  );
}

export function IconExtension({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.2 6.2V3.1M9.8 6.2V3.1M4.8 6.2h6.4v2.2A3.2 3.2 0 0 1 8 11.6a3.2 3.2 0 0 1-3.2-3.2V6.2Z" />
      <path d="M8 11.6v2.2" />
    </svg>
  );
}

export function IconTerminal({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.7" y="2.2" width="12.6" height="11.6" rx="2" />
      <path d="m4.2 5.2 2.3 2.1-2.3 2.1M8.2 10h3.2" />
    </svg>
  );
}

export function IconSettings({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6.8 1.8.4 1.4c.5-.1 1.1-.1 1.6 0l.4-1.4 1.7.7-.7 1.3c.4.3.8.7 1.1 1.1l1.3-.7.7 1.7-1.4.4c.1.5.1 1.1 0 1.6l1.4.4-.7 1.7-1.3-.7c-.3.4-.7.8-1.1 1.1l.7 1.3-1.7.7-.4-1.4c-.5.1-1.1.1-1.6 0l-.4 1.4-1.7-.7.7-1.3c-.4-.3-.8-.7-1.1-1.1l-1.3.7-.7-1.7 1.4-.4a4.5 4.5 0 0 1 0-1.6l-1.4-.4.7-1.7 1.3.7c.3-.4.7-.8 1.1-1.1l-.7-1.3 1.7-.7Z" />
      <circle cx="8" cy="7.1" r="1.8" />
    </svg>
  );
}

export function IconRefresh({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 5.8A5.4 5.4 0 0 0 3.1 5L2 6.3M3 10.2A5.4 5.4 0 0 0 12.9 11l1.1-1.3" />
      <path d="M2 3.2v3.1h3.1M14 12.8V9.7h-3.1" />
    </svg>
  );
}

export function IconCode({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.2 3.5 2.8 8l3.4 4.5M9.8 3.5 13.2 8l-3.4 4.5" />
    </svg>
  );
}

export function IconInfo({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 7.2V11M8 5.2v.2" />
    </svg>
  );
}

export function IconPencil({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.2 3.4 12.6 6.8 6 13.4H2.6V10z" />
      <path d="M8 4.6 11.4 8" />
    </svg>
  );
}

export function IconExpand({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 3.2H12.8V6.5M6.5 12.8H3.2V9.5M12.8 3.2 9.2 6.8M3.2 12.8 6.8 9.2" />
    </svg>
  );
}

export function IconContract({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.8 6.8H9.5V3.5M3.2 9.2H6.5V12.5M9.8 3.5 12.8 6.5M6.2 12.5 3.2 9.5" />
    </svg>
  );
}

/** Chat pane: used in the compact/dense view switcher. */
export function IconChat({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.2 3.2h9.6v7.2H6.4L3.2 13.2z" />
    </svg>
  );
}

/** Git-style branch: trajectory / history of a turn. */
export function IconBranch({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4.2" cy="3.4" r="1.4" />
      <circle cx="4.2" cy="12.6" r="1.4" />
      <circle cx="11.8" cy="8" r="1.4" />
      <path d="M4.2 4.8v6.4M4.2 8h4.2a3.4 3.4 0 0 0 3.4-3.4" />
    </svg>
  );
}

/** Three lines: backend log. */
export function IconList({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      <path d="M3 4.2h10M3 8h10M3 11.8h10" />
    </svg>
  );
}

/** Counter-clockwise arrow over a clock: restore files to an earlier point. */
export function IconHistory({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
      <path d="M2.4 2.6v3h3" />
      <path d="M8 5.2V8l2 1.2" />
    </svg>
  );
}

/** Laptop: deploy local (build working tree as-is + restart). */
export function IconLaptop({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="10" height="7.2" rx="0.9" />
      <path d="M3.2 10.2 2.4 13.2M12.8 10.2l.8 3M1.8 13.2h12.4" />
    </svg>
  );
}

/** Hosted-model mark: a filled blue cloud, colored like the backend logos. */
export function IconCloudModel({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M7 18h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.6 4.2 4.2 0 0 0 7 18z" />
    </svg>
  );
}

/** Hosted-model markers: the server's " ☁", ids ending ":cloud", "(cloud)". */
const CLOUD_SUFFIX = /\s*(?:☁|\(cloud\)|:cloud)$/i;

/**
 * A model name with any cloud marker drawn as the cloud glyph, and the
 * family word before the version in caps ("glm 5.3 flash" → "GLM 5.3 flash").
 */
export function ModelName({ name }: { name: string }) {
  const cloud = CLOUD_SUFFIX.test(name);
  const base = name
    .replace(CLOUD_SUFFIX, "")
    .replace(/^\S+(?= \d)/, (family) => family.toUpperCase());
  if (!cloud) return <>{base}</>;
  return (
    <>
      {base}
      <span className="model-cloud" title="Cloud model">
        <IconCloudModel />
      </span>
    </>
  );
}

/** Cloud: deploy cloud (git pull + build + restart). */
export function IconCloud({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.6 12.5a3.1 3.1 0 0 1-.5-6.16 4.1 4.1 0 0 1 8-.83 3.05 3.05 0 0 1-.6 6.99H4.6Z" />
    </svg>
  );
}

function LogoPi({ size }: { size: number }) {
  // Official pi mark (pi.dev), in its own three brand colors.
  return (
    <svg viewBox="115 115 570 570" width={size} height={size} aria-hidden>
      <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
      <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
      <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

function LogoClaude({ size }: { size: number }) {
  // Claude spark (simple-icons), in its brand orange whatever the wrapper color.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="#D97757"
        d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      />
    </svg>
  );
}

function LogoGrok({ size }: { size: number }) {
  // Grok mark (lobehub icons); xAI is monochrome, so it follows the text color.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
      />
    </svg>
  );
}

function LogoCodex({ size }: { size: number }) {
  // OpenAI blossom (simple-icons); monochrome brand, follows the text color.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

/** Agent marks without the square tile — π / asterisk / spark / hex. */
export function BackendLogo({
  backend,
  size = 24,
}: {
  backend: string;
  size?: number;
}) {
  if (backend === "claude") return <LogoClaude size={size} />;
  if (backend === "grok") return <LogoGrok size={size} />;
  if (backend === "codex") return <LogoCodex size={size} />;
  if (backend === "pi") return <LogoPi size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <text x="12" y="17" textAnchor="middle" fontSize="16" fill="currentColor">
        ✦
      </text>
    </svg>
  );
}
