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

export const editorHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.modifier,
      tags.self,
    ],
    color: 'var(--pw-code-keyword)',
  },
  { tag: [tags.bool, tags.null, tags.atom, tags.unit], color: 'var(--pw-code-bool)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName, tags.macroName],
    color: 'var(--pw-code-func)',
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue, tags.special(tags.string), tags.regexp, tags.escape],
    color: 'var(--pw-code-string)',
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.standard(tags.typeName)],
    color: 'var(--pw-code-type)',
  },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--pw-code-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--pw-code-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--pw-code)' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: 'var(--pw-code-decorator)' },
  { tag: [tags.heading, tags.strong], color: 'var(--pw-code-keyword)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--pw-accent)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--dsw-alias-state-error-primary)' },
])

export const editorTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--pw-code)',
    backgroundColor: 'var(--pw-code-bg)',
    fontSize: '12.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ds-font-family-code)',
    lineHeight: '1.55',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '10px 0 32px', caretColor: 'var(--pw-accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'color-mix(in srgb, var(--pw-code) 38%, transparent)',
    border: 'none',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 8px 0 6px' },
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
 * Grammar for a path, loaded on demand — the JS/TS parser alone is larger than
 * the rest of this app's bundle, so none of them belong in the entry chunk.
 * An unknown extension is not an error: the editor still edits, it just has no
 * syntax tree.
 */
export async function languageForPath(path: string): Promise<Extension | null> {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''

  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript({
      jsx: extension === '.jsx' || extension === '.tsx',
      typescript: extension.startsWith('.t') || extension === '.mts' || extension === '.cts',
    })
  }
  if (extension === '.json' || extension === '.jsonc' || name === '.babelrc') {
    const { json } = await import('@codemirror/lang-json')
    return json()
  }
  if (['.css', '.scss', '.less'].includes(extension)) {
    const { css } = await import('@codemirror/lang-css')
    return css()
  }
  if (['.html', '.htm', '.vue', '.svelte'].includes(extension)) {
    const { html } = await import('@codemirror/lang-html')
    return html()
  }
  if (['.md', '.mdx', '.markdown'].includes(extension)) {
    const { markdown } = await import('@codemirror/lang-markdown')
    return markdown()
  }
  if (['.py', '.pyi'].includes(extension)) {
    const { python } = await import('@codemirror/lang-python')
    return python()
  }
  if (extension === '.rs') {
    const { rust } = await import('@codemirror/lang-rust')
    return rust()
  }
  return null
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
