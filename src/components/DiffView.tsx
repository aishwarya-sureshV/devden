import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { ToolDiff } from "../lib/toolCards";
import { expandRows, reviewRows, type ReviewRow } from "../lib/reviewRows";
import { syntaxLang, type SyntaxLang } from "../lib/syntaxPaint";
import { SynText } from "./SynText";
import { DiffColorButton } from "./DiffColorEditor";

// ponytail: rendering the whole file; cap so a 10k-line blob can't freeze the pane
const FULL_FILE_CAP = 256_000;

type Row = ReviewRow & { stop: number };
const changed = (row?: ReviewRow) =>
  row?.kind === "add" || row?.kind === "remove";

/**
 * The one diff surface: the whole file with changes painted in place,
 * ↑/↓ stepping between blocks of changed lines, and a marker strip.
 * Falls back to the diff's own hunks when the file on disk has moved on.
 */
export function DiffView({
  diff,
  path,
  layout = "unified",
  lead,
  tail,
}: {
  diff: ToolDiff;
  /** Absolute path; the current file is read from here. */
  path: string;
  layout?: "unified" | "split";
  lead?: ReactNode;
  tail?: ReactNode;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lang = syntaxLang(undefined, path);

  useEffect(() => {
    setFile(null);
    let cancelled = false;
    api.workspaceFile(path).then(
      (result) => {
        const ok =
          result.ok &&
          typeof result.content === "string" &&
          !result.binary &&
          !result.truncated &&
          result.content.length <= FULL_FILE_CAP;
        if (!cancelled) setFile(ok ? result.content! : null);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [path, diff]);

  const { rows, full, stops } = useMemo(() => {
    const whole = file === null ? null : expandRows(diff, file);
    let count = 0;
    const rows: Row[] = (whole ?? reviewRows(diff)).map((row, i, all) => ({
      ...row,
      stop: changed(row) && !changed(all[i - 1]) ? count++ : -1,
    }));
    return { rows, full: Boolean(whole), stops: count };
  }, [diff, file]);

  const anchors = () =>
    Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>("[data-stop]") ?? [],
    );
  const jump = (index: number) => {
    const root = bodyRef.current;
    const el = anchors()[index];
    if (root && el) root.scrollTop = Math.max(0, el.offsetTop - root.clientHeight / 3);
    setCurrent(index);
  };
  // Relative to what's on screen, so scrolling by hand and then pressing ↓
  // goes to the next change below, not the one after the last jump.
  const step = (dir: 1 | -1) => {
    const root = bodyRef.current;
    if (!root) return;
    const line = root.scrollTop + root.clientHeight / 3;
    const tops = anchors().map((el) => el.offsetTop);
    const next =
      dir > 0
        ? tops.findIndex((top) => top > line + 4)
        : tops.findLastIndex((top) => top < line - 4);
    if (next >= 0) jump(next);
  };

  // Land on the first change when a diff opens.
  useEffect(() => {
    if (stops) jump(0);
  }, [rows, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const root = bodyRef.current;
    if (!root) return;
    const line = root.scrollTop + root.clientHeight / 3;
    const index = anchors().findLastIndex((el) => el.offsetTop <= line + 4);
    setCurrent(Math.max(0, index));
  };

  return (
    <div className="dview">
      <div className="dview__bar">
        {lead}
        <span className="edit-well__stat">
          {diff.added > 0 && <span className="is-add">+{diff.added}</span>}
          {diff.removed > 0 && <span className="is-del">−{diff.removed}</span>}
        </span>
        {stops > 0 && (
          <span className="review-dock__hunk">
            <button
              type="button"
              className="review-dock__nav"
              aria-label="Previous change"
              title="Previous change"
              onClick={() => step(-1)}
            >
              ↑
            </button>
            {current + 1}/{stops}
            <button
              type="button"
              className="review-dock__nav"
              aria-label="Next change"
              title="Next change"
              onClick={() => step(1)}
            >
              ↓
            </button>
          </span>
        )}
        <DiffColorButton />
        {tail}
      </div>
      <div className="dview__frame">
        <div className="dview__body" ref={bodyRef} onScroll={onScroll}>
          {layout === "split" ? (
            <SplitRows rows={rows} lang={lang} full={full} />
          ) : (
            rows.map((row, index) =>
              full && row.kind === "meta" ? null : (
                <div
                  key={index}
                  data-stop={row.stop >= 0 ? row.stop : undefined}
                  className={`rdiff__line rdiff__unified is-${row.kind === "meta" ? "hunk" : row.kind}`}
                >
                  <span>{row.newNo || row.oldNo}</span>
                  <span>
                    {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}
                  </span>
                  <span>
                    <Text row={row} lang={lang} />
                  </span>
                </div>
              ),
            )
          )}
        </div>
        {stops > 0 && <Ruler rows={rows} onJump={jump} />}
      </div>
    </div>
  );
}

/**
 * Where the changes sit in the file. ponytail: positions by row index, so
 * long wrapped lines skew it slightly; measure offsets if that ever shows.
 */
function Ruler({ rows, onJump }: { rows: Row[]; onJump: (stop: number) => void }) {
  const marks: { kind: string; start: number; len: number; stop: number }[] = [];
  let stop = -1;
  rows.forEach((row, i) => {
    if (row.stop >= 0) stop = row.stop;
    if (!changed(row)) return;
    const last = marks.at(-1);
    if (last && last.kind === row.kind && last.start + last.len === i) last.len += 1;
    else marks.push({ kind: row.kind, start: i, len: 1, stop });
  });
  const pct = (n: number) => `${(n / rows.length) * 100}%`;
  return (
    <div className="dview__ruler" aria-hidden="true">
      {marks.map((mark) => (
        <span
          key={mark.start}
          className={`is-${mark.kind}`}
          style={{ top: pct(mark.start), height: `max(3px, ${pct(mark.len)})` }}
          onClick={() => onJump(mark.stop)}
        />
      ))}
    </div>
  );
}

function Text({ row, lang }: { row: ReviewRow; lang: SyntaxLang }) {
  if (row.kind === "meta") return <SynText text={row.text} lang={lang} variant="hunk" />;
  if (row.kind === "gap") return <>{row.text}</>;
  return <SynText text={row.text} lang={lang} />;
}

function SplitRows({ rows, lang, full }: { rows: Row[]; lang: SyntaxLang; full: boolean }) {
  const pairs: { left: Row | null; right: Row | null; stop: number }[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (!changed(row)) {
      if (!(full && row.kind === "meta"))
        pairs.push({ left: row, right: row.kind === "context" ? row : null, stop: -1 });
      i += 1;
      continue;
    }
    const stop = row.stop;
    const removed: Row[] = [];
    const added: Row[] = [];
    while (rows[i]?.kind === "remove") removed.push(rows[i++]!);
    while (rows[i]?.kind === "add") added.push(rows[i++]!);
    const count = Math.max(removed.length, added.length);
    for (let j = 0; j < count; j += 1)
      pairs.push({ left: removed[j] ?? null, right: added[j] ?? null, stop: j ? -1 : stop });
  }
  return (
    <>
      {pairs.map((pair, index) => (
        <div
          key={index}
          className="rdiff__split"
          data-stop={pair.stop >= 0 ? pair.stop : undefined}
        >
          <Side row={pair.left} lang={lang} old />
          <Side row={pair.right} lang={lang} />
        </div>
      ))}
    </>
  );
}

function Side({ row, lang, old }: { row: Row | null; lang: SyntaxLang; old?: boolean }) {
  if (!row)
    return (
      <div className="rdiff__side is-blank">
        <span />
        <span />
        <span> </span>
      </div>
    );
  return (
    <div className={`rdiff__side is-${row.kind}`}>
      <span>{old ? row.oldNo : row.newNo}</span>
      <span>{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span>
      <span>
        <Text row={row} lang={lang} />
      </span>
    </div>
  );
}
