/** Extensions the message renderer recognizes as a file chip, not a code chip. */
const FILE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|less|md|mdx|json|jsonc|yml|yaml|html|htm|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|txt|toml|lock)$/i;

/**
 * Does an inline-code token look like a file or path? Used to choose a
 * white "file chip" over an accent "code chip" in RichText.
 */
export function isFileToken(token: string): boolean {
  const text = token.trim();
  if (!text || /\s/.test(text)) return false;
  if (text.includes("/")) return true;
  const withoutLineSuffix = text.replace(/:\d+(?::\d+)?$/, "");
  return FILE_EXTENSIONS.test(withoutLineSuffix);
}
