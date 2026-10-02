import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { tabLabelFor } from "./runInTerminal";

export type TerminalRunStatus = "queued" | "running" | "exited" | "error";

export type TerminalRun = {
  id: string;
  command: string;
  tabLabel: string;
  status: TerminalRunStatus;
  output: string;
  exitCode: number | null;
  error?: string;
  interactive?: boolean;
};

type TerminalRunsApi = {
  runs: Record<string, TerminalRun>;
  runCommand: (command: string, interactive?: boolean) => string | null;
  claimRun: (id: string) => boolean;
  reportOutput: (id: string, output: string) => void;
  finishRun: (id: string, exitCode: number | null, error?: string) => void;
};

const TerminalRunsContext = createContext<TerminalRunsApi | null>(null);

export function useTerminalRuns() {
  return useContext(TerminalRunsContext);
}

export function TerminalRunsProvider({
  children,
  onNeedOpen,
}: {
  children: ReactNode;
  onNeedOpen: () => void;
}) {
  const [runs, setRuns] = useState<Record<string, TerminalRun>>({});
  const claimed = useRef(new Set<string>());
  const onNeedOpenRef = useRef(onNeedOpen);
  onNeedOpenRef.current = onNeedOpen;

  const runCommand = useCallback((command: string, interactive = false) => {
    const trimmed = command.replace(/\s+$/g, "");
    if (!trimmed.trim()) return null;
    const id = crypto.randomUUID();
    const run: TerminalRun = {
      id,
      command: trimmed,
      tabLabel: tabLabelFor(trimmed),
      status: "queued",
      output: "",
      exitCode: null,
      interactive,
    };
    setRuns((current) => ({ ...current, [id]: run }));
    onNeedOpenRef.current();
    return id;
  }, []);

  const claimRun = useCallback((id: string) => {
    if (claimed.current.has(id)) return false;
    claimed.current.add(id);
    setRuns((current) => {
      const run = current[id];
      if (!run || run.status !== "queued") return current;
      return { ...current, [id]: { ...run, status: "running" } };
    });
    return true;
  }, []);

  const reportOutput = useCallback((id: string, output: string) => {
    setRuns((current) => {
      const run = current[id];
      if (!run || run.output === output) return current;
      return { ...current, [id]: { ...run, output } };
    });
  }, []);

  const finishRun = useCallback(
    (id: string, exitCode: number | null, error?: string) => {
      setRuns((current) => {
        const run = current[id];
        if (!run || run.status === "exited" || run.status === "error")
          return current;
        return {
          ...current,
          [id]: {
            ...run,
            status: error ? "error" : "exited",
            exitCode,
            error,
          },
        };
      });
    },
    [],
  );

  const value = useMemo(
    () => ({ runs, runCommand, claimRun, reportOutput, finishRun }),
    [runs, runCommand, claimRun, reportOutput, finishRun],
  );

  return (
    <TerminalRunsContext.Provider value={value}>
      {children}
    </TerminalRunsContext.Provider>
  );
}
