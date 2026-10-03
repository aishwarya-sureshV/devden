const icons = import.meta.glob<string>("../assets/workbench/**/*.svg", { query: "?raw", import: "default", eager: true });
const folderColors: Record<string, string> = {"_default": "#9aa4b8", "bin": "#ff7a8a", "dist": "#9aa4b8", "electron": "#5fd49a", "node_modules": "#7a7884", "packaging": "#c3a6ff", "public": "#6aa8ff", "scripts": "#f0c84a", "server": "#ff9f6a", "src": "#4fd1c5", "components": "#6ad4e0", "lib": "#e8b84a", "styles": "#ff9cc4"};
export function WorkbenchIcon({ kind, name }: { kind: "tools" | "folders" | "ui"; name: string }) {
  const key = `../assets/workbench/${kind}/${name}.svg`;
  const svg = icons[key] ?? icons[`../assets/workbench/${kind}/${kind === "folders" ? "_default" : "_unknown"}.svg`];
  return <span className="workbench-icon" style={kind === "folders" ? { color: folderColors[name] ?? folderColors._default } : undefined} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />;
}
