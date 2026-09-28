/**
 * Palette picker for the syntax theme used by the workspace editor and the
 * read-only highlighter. The actual colours live as `--pw-code-*` overrides in
 * theme.css under `body[data-code-theme="…"]` — this module is only the
 * picker state: list, persistence, and applying the attribute.
 */
export type CodeThemeId =
 | "default"
 | "workbench"
 | "vscode"
 | "github"
 | "onedark"
 | "solarized"
 | "tokyonight";

export const CODE_THEMES: { id: CodeThemeId; label: string }[] = [
 { id: "workbench", label: "Workbench" },
 { id: "vscode", label: "VS Code" },
 { id: "default", label: "devden" },
 { id: "github", label: "GitHub" },
 { id: "onedark", label: "One Dark / Light" },
 { id: "solarized", label: "Solarized" },
 { id: "tokyonight", label: "Tokyo Night" },
];

// v2: the workbench redesign resets everyone onto its own editor palette.
const KEY = "devden.code-theme.v2";

export function codeTheme(): CodeThemeId {
 const saved = localStorage.getItem(KEY);
 return (
  // Workbench (the redesign's editor palette) is the default look.
  (
   CODE_THEMES.some((theme) => theme.id === saved) ? saved : "workbench"
  ) as CodeThemeId
 );
}

export function applyCodeTheme(id: CodeThemeId): void {
 if (id === "default") document.body.removeAttribute("data-code-theme");
 else document.body.setAttribute("data-code-theme", id);
 localStorage.setItem(KEY, id);
}
