/**
 * Palette picker for the syntax theme used by the workspace editor and the
 * read-only highlighter. The actual colours live as `--pw-code-*` overrides in
 * theme.css under `body[data-code-theme="…"]` — this module is only the
 * picker state: list, persistence, and applying the attribute.
 */
export type CodeThemeId =
 | "default"
 | "vscode"
 | "github"
 | "onedark"
 | "solarized"
 | "tokyonight";

export const CODE_THEMES: { id: CodeThemeId; label: string }[] = [
 { id: "vscode", label: "VS Code" },
 { id: "default", label: "devden" },
 { id: "github", label: "GitHub" },
 { id: "onedark", label: "One Dark / Light" },
 { id: "solarized", label: "Solarized" },
 { id: "tokyonight", label: "Tokyo Night" },
];

const KEY = "devden.code-theme";

export function codeTheme(): CodeThemeId {
 const saved = localStorage.getItem(KEY);
 return (
  // VS Code is the default look: a user who never touched the header picker
  // should get the subtle palette, not the old warm ramp.
  (
   CODE_THEMES.some((theme) => theme.id === saved) ? saved : "vscode"
  ) as CodeThemeId
 );
}

export function applyCodeTheme(id: CodeThemeId): void {
 if (id === "default") document.body.removeAttribute("data-code-theme");
 else document.body.setAttribute("data-code-theme", id);
 localStorage.setItem(KEY, id);
}
