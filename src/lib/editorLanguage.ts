/**
 * CodeMirror language + theme wiring.
 *
 * Colours come from the same `--pw-code-*` variables the read-only highlighter
 * in `highlight.tsx` uses, so the editor matches the rest of the app and light
 * and dark switch with the theme attribute — no second palette, and no
 * reconfiguring the view when the theme flips.
 */
import { HighlightStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// Claude Code palette; colors live in conversation.css (--cc-*) for light/dark.
export const editorHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier, tags.self],
    color: 'var(--cc-kw)',
  },
  { tag: [tags.bool, tags.null, tags.atom, tags.unit, tags.number, tags.integer, tags.float], color: 'var(--cc-num)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName, tags.macroName],
    color: 'var(--cc-fn)',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue, tags.special(tags.string), tags.regexp, tags.escape],
    color: 'var(--cc-str)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: 'var(--cc-type)' },
  { tag: tags.tagName, color: 'var(--cc-tag)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--cc-attr)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--cc-com)', fontStyle: 'italic' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: 'var(--cc-fn)' },
  { tag: [tags.heading, tags.strong], color: 'var(--cc-kw)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--cc-attr)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--dsw-alias-state-error-primary)' },
])

export const editorTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--pw-code)',
    backgroundColor: 'var(--pw-code-bg)',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ds-font-family-code)',
    lineHeight: '18px',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '6px 0 32px', caretColor: 'var(--pw-accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'color-mix(in srgb, var(--pw-code) 38%, transparent)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '44px', padding: '0 16px 0 0' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px', cursor: 'pointer' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--pw-code) 6%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--pw-code) 6%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--pw-accent-tint-2) !important',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--pw-accent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--pw-accent) 22%, transparent)',
    outline: '1px solid var(--pw-accent-line)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--pw-accent) 14%, transparent)' },
  '.cm-panels, .cm-tooltip': {
    border: '1px solid var(--dsw-alias-border-l2)',
    backgroundColor: 'var(--pw-card)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '11.5px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontSize: '11.5px',
  },
  '.cm-panel.cm-search input': {
    padding: '3px 6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '5px',
    background: 'var(--pw-code-bg)',
    color: 'var(--dsw-alias-label-primary)',
  },
  // CodeMirror's base theme styles panel controls for a light editor; this app
  // has both themes, so the controls have to follow the same variables.
  '.cm-panel .cm-button': {
    margin: '0 2px',
    padding: '1px 6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '5px',
    background: 'transparent',
    backgroundImage: 'none',
    color: 'inherit',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name="close"]': { color: 'inherit', cursor: 'pointer' },
  '.cm-panel input[type="checkbox"]': { accentColor: 'var(--pw-accent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--pw-code-number) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--pw-accent-tint-2)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--ds-font-family-code)', maxHeight: '220px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--pw-accent-tint-2)',
    color: 'var(--dsw-alias-label-primary)',
  },
})

/**
 * Grammar for a path, loaded on demand from @codemirror/language-data (100+
 * languages, each its own chunk). An unknown extension is not an error: the
 * editor still edits, it just has no syntax tree.
 */
export async function languageForPath(path: string): Promise<Extension | null> {
  const [{ LanguageDescription }, { languages }] = await Promise.all([
    import('@codemirror/language'),
    import('@codemirror/language-data'),
  ])
  const name = path.split('/').pop() ?? ''
  const description = LanguageDescription.matchFilename(languages, name)
  return description ? await description.load() : null
}

/** The identifier spanning `pos`, or null if the cursor is not inside one. */
export function symbolAt(line: string, offset: number): string | null {
  const isWord = (char: string) => /[A-Za-z0-9_$]/.test(char)
  let start = Math.min(Math.max(offset, 0), line.length)
  let end = start
  while (start > 0 && isWord(line[start - 1])) start -= 1
  while (end < line.length && isWord(line[end])) end += 1
  const symbol = line.slice(start, end)
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol) ? symbol : null
}
