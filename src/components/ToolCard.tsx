import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { TimelineItem } from "../lib/timeline";
import {
  getToolDiff,
  getToolFileView,
  isFileEditTool,
  type ToolDiff,
  type ToolFileView,
} from "../lib/toolCards";
import { syntaxLang } from "../lib/syntaxPaint";
import {
  describeTool,
  formatDuration,
  formatWorkingClock,
  liveFraction,
  unknownProgress,
  windowExplored,
  type RepeatEntry,
  type ResultPart,
  type ToolRowModel,
} from "../lib/toolRow";
import { SynText } from "./SynText";
import { toolLook } from "../lib/workbenchLook";
import { WorkbenchIcon } from "./WorkbenchIcon";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function splitPath(path: string): { dir: string; file: string } {
  const parts = path.split("/");
  const file = parts.pop() || path;
  return { dir: parts.length ? `${parts.join("/")}/` : "", file };
}

/** Recessed edit preview. Nine lines, then a fade and a more-lines toggle. */
function EditWell({
  title,
  diff,
  inDock,
  dockWord,
  onOpen,
  cwd = "",
}: {
  title: string;
  cwd?: string;
  diff: ToolDiff;
  inDock: boolean;
  dockWord: string;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const code = diff.lines.filter((line) => line.kind !== "meta");
  const preview = 9;
  const shown = expanded ? code : code.slice(0, preview);
  const more = code.length - shown.length;
  // Repo-relative in the header ("server/x.js"), full path on hover.
  const root = cwd.replace(/\/+$/, "");
  const path = splitPath(root && title.startsWith(`${root}/`) ? title.slice(root.length + 1) : title);
  const lang = syntaxLang(undefined, title);
  return (
    <div className={`edit-well${inDock ? " is-open" : ""}`}>
      <div className="edit-well__head">
        <span className="edit-well__verb"><WorkbenchIcon kind="tools" name="edit" />edit</span>
        <span className="edit-well__path" title={title}>
          {path.dir && <span>{path.dir}</span>}
          <strong>{path.file}</strong>
        </span>
        <span className="edit-well__stat">
          {diff.added > 0 && <span className="is-add">+{diff.added}</span>}
          {diff.removed > 0 && <span className="is-del">−{diff.removed}</span>}
        </span>
        <button type="button" className="edit-well__open" onClick={onOpen}>
          {inDock ? dockWord : "Open diff ↗"}
        </button>
      </div>
      <div className={`edit-well__body${more > 0 ? " is-fade" : ""}`}>
        {shown.map((line, index) => (
          <div key={index} className={`edit-well__line is-${line.kind}`}>
            <span>{line.lineNo ?? ""}</span>
            <span>
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
            </span>
            <span>
              <SynText text={line.text} lang={lang} />
            </span>
          </div>
        ))}
      </div>
      {code.length > preview && (
        <button
          type="button"
          className="edit-well__more"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded
            ? "Show fewer lines"
            : `${code.length - preview} more lines`}
        </button>
      )}
    </div>
  );
}

export function ToolCard({
  item,
  onOpenFile,
  children = [],
  cwd = "",
  repeat = 1,
  expandDiff = false,
  dockTitle = null,
  dockWord = "In panel",
}: {
  item: ToolItem;
  onOpenFile: (view: ToolFileView) => void;
  onOpenSubagent?: (id: string) => void;
  children?: ToolItem[];
  cwd?: string;
  repeat?: number;
  expandDiff?: boolean;
  /** Title of the file currently open in the review dock, if this session owns it. */
  dockTitle?: string | null;
  dockWord?: string;
}) {
  const model = describeTool(item, cwd, repeat);
  const offset = Number(item.args.offset ?? item.args.start_line ?? 0);
  const limit = Number(item.args.limit ?? item.args.end_line ?? 0);
  const range = model.detail === "file" && model.thread === "settled" && offset > 0 && limit > 0
    ? ` · L${offset}–${item.args.end_line ? limit : offset + limit - 1}` : "";
  const elapsed = useElapsed(item);
  const running = item.status === "running";
  const duration = running ? formatDuration(elapsed, true) : model.duration;
  const [open, setOpen] = useState(
    (item.status === "error" && model.thread === "failed") ||
      (expandDiff && model.detail === "diff" && isFileEditTool(item.name)),
  );
  const parts: ResultPart[] =
    children.length > 0
      ? [...model.parts, { text: ` · ${children.length} nested`, tone: "dim" }]
      : model.parts;
  const showNote =
    Boolean(model.note) &&
    (model.thread === "failed" || model.thread === "stopped" || open);
  const showTail = running && Boolean(model.tail) && !open;

  const activate = () => {
    if (model.detail === "file") {
      const view = getToolFileView(item);
      if (view) {
        onOpenFile(view);
        return;
      }
    }
    if (
      model.detail === "none" &&
      !model.list.length &&
      !model.diffLines.length
    )
      return;
    setOpen((value) => !value);
  };

  const openDiff = () => {
    const view = getToolFileView(item);
    const diff = getToolDiff(item);
    if (view) onOpenFile(view);
    else if (diff) onOpenFile({ title: model.title, diff });
  };
  const fullDiff = model.detail === "diff" ? getToolDiff(item) : null;
  if (fullDiff && (fullDiff.added > 0 || fullDiff.removed > 0)) {
    const fileView = getToolFileView(item);
    const title = fileView?.title || model.title;
    return (
      <article className="tl tl--tool">
        <span className="tl__node" />
        <EditWell
          title={title}
          cwd={cwd}
          diff={fullDiff}
          inDock={dockTitle === title}
          dockWord={dockWord}
          onOpen={() =>
            onOpenFile(
              fileView
                ? { ...fileView, diff: fullDiff }
                : { title, diff: fullDiff },
            )
          }
        />
      </article>
    );
  }
  return (
    <article className="tl tl--tool">
      <span className="tl__node" />
      <div className={`trow-stack is-${model.thread}`}>
        <CallRow
          range={range}
          toolName={item.name.startsWith("mcp") ? item.name : model.verb}
          model={{ ...model, parts, duration }}
          signal={item.output}
          expanded={open}
          onClick={activate}
          action={
            model.detail === "diff" && model.diffMore ? (
              <span
                className="trow__open"
                title="Open the full diff"
                onClick={(event) => {
                  event.stopPropagation();
                  openDiff();
                }}
              >
                open diff
              </span>
            ) : undefined
          }
        />
        {showNote && (
          <div
            className={`trow__note${model.thread === "failed" ? " is-fail" : ""}`}
          >
            {model.note}
          </div>
        )}
        {showTail && <div className="trow__note">{model.tail}</div>}
        {open && model.detail === "diff" && model.diffLines.length > 0 && (
          <DiffBlock model={model} />
        )}
        {open &&
          (model.detail === "list" ||
            model.detail === "log" ||
            (model.detail === "file" && model.list.length > 0)) && (
            <ListBlock
              lines={model.list}
              pattern={model.pattern}
              grouped={model.verb === "grep"}
              more={item.output.split("\n").length > model.list.length}
              onOpen={() =>
                onOpenFile({
                  title: model.title || model.verb,
                  content: item.output,
                  language: model.verb === "bash" ? "bash" : undefined,
                })
              }
            />
          )}
        {children.length > 0 &&
          (open || children.some((child) => child.status === "running")) && (
            <div className="trow-nest trow-nest--agent">
              {children.map((child) => (
                <ToolCard
                  key={child.id}
                  item={child}
                  onOpenFile={onOpenFile}
                  cwd={cwd}
                  dockTitle={dockTitle}
                  dockWord={dockWord}
                />
              ))}
            </div>
          )}
      </div>
    </article>
  );
}

export function ExploredRows({
  entries,
  calls,
  failed,
  durationMs,
  cwd,
  expandDiff,
  onOpenFile,
}: {
  entries: RepeatEntry[];
  calls: number;
  failed: number;
  durationMs: number;
  cwd?: string;
  expandDiff?: boolean;
  onOpenFile: (view: ToolFileView) => void;
}) {
  const [open, setOpen] = useState(false);
  const windowed = open
    ? windowExplored(entries, calls)
    : { entries: [], hidden: 0 };
  const parts: ResultPart[] = [
    { text: String(calls), tone: "num" },
    { text: calls === 1 ? " call" : " calls", tone: "dim" },
  ];
  if (failed > 0) {
    parts.push(
      { text: " · ", tone: "dim" },
      { text: `${failed} failed`, tone: "fail" },
    );
  }
  const counts = entries.reduce<Record<string, number>>((all, entry) => {
    const verb = describeTool(entry.item, cwd, entry.repeat).verb;
    all[verb] = (all[verb] ?? 0) + entry.repeat;
    return all;
  }, {});
  const model: ToolRowModel = {
    verb: "explored",
    accent: false,
    tag: "",
    prefix: "",
    main: open ? "reads and searches · click to fold" : "reads and searches",
    suffix: "",
    sans: false,
    strike: false,
    dimVerb: false,
    title: `${calls} calls`,
    parts,
    duration: formatDuration(durationMs),
    thread: "settled",
    breakAt: 100,
    note: "",
    tail: "",
    detail: "none",
    list: [],
    pattern: "",
    diffLines: [],
    diffMore: false,
    diffLabel: "",
  };
  return (
    <div className="trow-explored">
      <article className="tl tl--tool">
        <span className="tl__node" />
        <div className="trow-stack is-settled">
          <CallRow
            model={model}
            summary={<>Explored{Object.entries(counts).map(([verb, count]) => <span key={verb}> · <b style={{ color: toolLook(verb).color, fontWeight: 600 }}>{count}</b> {verb}</span>)}</>}
            action={<span className="trow__open">{open ? "Fold" : "Expand"}</span>}
            expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
        </div>
      </article>
      {open && (
        <div className="trow-nest">
          {windowed.entries.map((entry, index) => (
            <div
              key={entry.item.id}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <ToolCard
                item={entry.item}
                repeat={entry.repeat}
                cwd={cwd}
                expandDiff={expandDiff}
                onOpenFile={onOpenFile}
              />
            </div>
          ))}
          {windowed.hidden > 0 && (
            <div className="trow__note">+{windowed.hidden} more</div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkingLine({
  startedAt,
  tools,
  failed,
  parallel,
}: {
  startedAt: number;
  tools: number;
  failed: number;
  parallel: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="trow-status">
      <span className="trow-status__verb">Working</span>
      <span className="trow-status__meta">
        {` · ${formatWorkingClock(Math.max(0, now - startedAt))} · ${tools} tool${tools === 1 ? "" : "s"}`}
        {parallel > 1 ? ` · ${parallel} running in parallel` : ""}
      </span>
      {failed > 0 && (
        <span className="trow-status__fail">{` · ${failed} failed`}</span>
      )}
    </div>
  );
}

export function CallRow({
  range,
  summary,
  toolName,
  model,
  signal = "",
  expanded,
  onClick,
  action,
}: {
  range?: string;
  summary?: ReactNode;
  toolName?: string;
  model: ToolRowModel;
  /** Live output, so a "12 of 14" can pull the thread instead of the clock. */
  signal?: string;
  expanded: boolean;
  onClick: () => void;
  /** Optional inline action inside the pill, e.g. "open diff". */
  action?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="trow"
      style={{ "--tool-color": toolLook(toolName ?? model.verb).color } as CSSProperties}
      aria-expanded={expanded}
      aria-label={`${model.verb} ${model.title} ${model.parts.map((part) => part.text).join("")}`.trim()}
      onClick={onClick}
    >
      <span className="trow__grid">
        <span
          className={`trow__verb${model.accent ? " is-accent" : ""}${model.verb.length > 7 ? " is-wide" : ""}`}
        >
          <WorkbenchIcon kind="tools" name={toolLook(toolName ?? model.verb).icon} />{model.verb}
        </span>
        <span className="trow__main">
          <span
            className={`trow__arg${model.sans ? " is-sans" : ""}`}
            title={model.title}
          >
            {model.tag && <span className="trow__tag">{model.tag}</span>}
            {model.prefix && (
              <span className="trow__dim trow__prefix">{model.prefix}</span>
            )}
            <span className="trow__bright">{summary ?? model.main}</span>
            {model.suffix && (
              <span className="trow__dim trow__suffix">{model.suffix}</span>
            )}
            <i className={`trow__strike${model.strike ? " is-on" : ""}`} />
          </span>
          <span
            className="trow__result"
            aria-label={model.parts.map((part) => part.text).join("")}
          >
            {model.detail === "file" && model.prefix && <span className="trow__folder" title={model.prefix}>{model.prefix} · </span>}
            {model.parts.map((part, index) => (
              <AnimatedText key={index} text={part.text} tone={part.tone} />
            ))}
            {range && <span className="trow__range">{range}</span>}
          </span>
          <span className="trow__dur">{model.duration}</span>
          {action}
          <ThreadLine
            kind={model.thread}
            breakAt={model.breakAt}
            signal={signal}
          />
        </span>
      </span>
    </button>
  );
}

function AnimatedText({
  text,
  tone,
}: {
  text: string;
  tone: ResultPart["tone"];
}) {
  const bits = text.split(/(\d+)/);
  return (
    <span className={`trow__part is-${tone}`}>
      {bits.map((bit, index) =>
        /^\d+$/.test(bit) ? (
          <RollingNumber key={index} value={Number(bit)} />
        ) : (
          <span key={index}>{bit}</span>
        ),
      )}
    </span>
  );
}

function RollingNumber({ value }: { value: number }) {
  const text = String(Math.max(0, value));
  return (
    <span className="trow__roll" aria-hidden>
      {text.split("").map((glyph, index) => (
        <Digit
          key={text.length - index}
          digit={Number(glyph)}
          delay={index * 45}
        />
      ))}
    </span>
  );
}

function Digit({ digit, delay }: { digit: number; delay: number }) {
  const reduce = useRef(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [on, setOn] = useState(reduce.current);
  useEffect(() => {
    if (reduce.current) return;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setOn(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);
  const shown = on ? digit : 0;
  return (
    <span className="trow__digit">
      <span
        style={{
          transform: `translateY(-${(shown + 1) * 20}px)`,
          transition: on
            ? `transform 520ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`
            : "none",
        }}
      >
        <span>&nbsp;</span>
        {"0123456789".split("").map((mark) => (
          <span key={mark}>{mark}</span>
        ))}
      </span>
    </span>
  );
}

function ThreadLine({
  kind,
  breakAt,
  signal,
}: {
  kind: ToolRowModel["thread"];
  breakAt: number;
  signal: string;
}) {
  const barRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const held = useRef(0);
  const goalRef = useRef<number | null>(null);
  goalRef.current =
    kind === "running" || kind === "waiting" ? liveFraction(signal) : null;
  const segmented = goalRef.current != null;

  useLayoutEffect(() => {
    const bar = barRef.current;
    const head = headRef.current;
    if (!bar || !head) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let raf = 0;
    const paint = (p: number, headOn: boolean) => {
      const clamped = Math.max(0, Math.min(1, p));
      held.current = clamped;
      bar.style.width = `${clamped * 100}%`;
      head.style.left = `calc(${clamped * 100}% - 44px)`;
      if (kind !== "waiting") head.style.opacity = headOn ? "0.95" : "0";
    };
    const final =
      kind === "failed" || kind === "stopped" || kind === "denied"
        ? breakAt / 100
        : 1;

    if (reduce) {
      paint(kind === "running" || kind === "waiting" ? 0.92 : final, false);
      return;
    }

    if (kind === "running" || kind === "waiting") {
      const started = performance.now();
      let shown = held.current;
      const tick = (now: number) => {
        const clock = unknownProgress(now - started);
        const real = goalRef.current;
        const goal = real == null ? clock : real;
        shown += (goal - shown) * (real == null ? 1 : 0.09);
        if (real == null) shown = clock;
        paint(shown, true);
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
      return () => window.cancelAnimationFrame(raf);
    }

    const from = held.current;
    if (from < 0.02) {
      paint(final, false);
      return;
    }
    const dur = kind === "failed" ? 220 : 640;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const eased = 1 - (1 - t) ** 3;
      paint(from + (final - from) * eased, kind === "settled" && t < 1);
      if (t < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [kind, breakAt]);

  return (
    <span className="trow__thread">
      <i
        ref={barRef}
        className={`trow__thread-bar${segmented ? " is-segmented" : ""}`}
      />
      <i ref={headRef} className="trow__thread-head" />
    </span>
  );
}

function DiffBlock({ model }: { model: ToolRowModel }) {
  // Gutter sized to the widest line number, so 4-digit rows don't clip.
  const gutter = String(
    Math.max(0, ...model.diffLines.map((line) => line.lineNo ?? 0)),
  ).length;
  return (
    <div className="trow__panel trow__panel--diff">
      <div
        className="trow__diff"
        style={{ "--diff-gutter": `${gutter}ch` } as CSSProperties}
      >
        {model.diffLabel && (
          <div className="trow__diff-label">{model.diffLabel}</div>
        )}
        {model.diffLines.map((line, index) => (
          <div
            key={`${index}-${line.kind}`}
            className={`trow__diff-line is-${line.kind}`}
            style={{ "--i": String(index) } as CSSProperties}
          >
            <span>{line.lineNo ?? ""}</span>
            <span>
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListBlock({
  lines,
  pattern,
  grouped,
  more,
  onOpen,
}: {
  lines: string[];
  pattern: string;
  grouped: boolean;
  more: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="trow__panel">
      {grouped ? (
        <GrepList lines={lines} pattern={pattern} />
      ) : (
        <pre className="trow__log">{lines.join("\n")}</pre>
      )}
      {more && (
        <button type="button" className="trow__more" onClick={onOpen}>
          open log
        </button>
      )}
    </div>
  );
}

function GrepList({ lines, pattern }: { lines: string[]; pattern: string }) {
  const groups: { file: string; rows: { no: string; text: string }[] }[] = [];
  const plain: string[] = [];
  for (const line of lines) {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match) {
      plain.push(line);
      continue;
    }
    const row = { no: match[2]!, text: match[3]! };
    const last = groups.at(-1);
    if (last && last.file === match[1]) last.rows.push(row);
    else groups.push({ file: match[1]!, rows: [row] });
  }
  return (
    <div className="trow__matches">
      {groups.map((group) => (
        <div key={group.file}>
          <div className="trow__match-file">{group.file}</div>
          {group.rows.map((row) => (
            <div
              key={`${group.file}:${row.no}:${row.text}`}
              className="trow__match-line"
            >
              <span>{row.no}</span>
              <span>
                <Highlight text={row.text} pattern={pattern} />
              </span>
            </div>
          ))}
        </div>
      ))}
      {plain.map((line) => (
        <div key={line} className="trow__match-line">
          <span />
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}

function Highlight({ text, pattern }: { text: string; pattern: string }) {
  const needle = pattern.replace(/^"|"$/g, "");
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function useElapsed(item: ToolItem): number {
  const running = item.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [running]);
  if (!running) return item.elapsed ?? 0;
  return Math.max(0, now - item.startedAt);
}
