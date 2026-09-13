/**
 * The workspace editor: CodeMirror 6 with `basicSetup`, which is where the
 * "full editor" behaviour comes from — undo history, multi-cursor, bracket
 * matching and closing, code folding, autocomplete, in-file find/replace
 * (Mod-f), rectangular selection. Everything below that is the wiring specific
 * to this app: save, jump-to-line, and Cmd-click to a definition.
 */
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorSelection, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { editorHighlightStyle, editorTheme, languageForPath, symbolAt } from '../lib/editorLanguage'

export type EditorNavigation = { line: number; column?: number; token: number }

export function CodeEditor({
  path,
  value,
  readOnly = false,
  navigation,
  onChange,
  onSave,
  onDefinition,
}: {
  path: string
  value: string
  readOnly?: boolean
  navigation?: EditorNavigation | null
  onChange: (next: string) => void
  onSave: () => void
  onDefinition: (symbol: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Callbacks live in refs so a re-render never tears down the view: rebuilding
  // it would drop undo history, folds, and the cursor mid-edit.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onDefinitionRef = useRef(onDefinition)
  const valueRef = useRef(value)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onDefinitionRef.current = onDefinition
  valueRef.current = value

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const language = new Compartment()
    let disposed = false

    /** The identifier under a document position, for Cmd-click and F12. */
    const symbolAtPos = (view: EditorView, pos: number) => {
      const line = view.state.doc.lineAt(pos)
      return symbolAt(line.text, pos - line.from)
    }

    const view = new EditorView({
      doc: valueRef.current,
      parent: host,
      extensions: [
        basicSetup,
        editorTheme,
        syntaxHighlighting(editorHighlightStyle),
        EditorView.lineWrapping,
        language.of([]),
        EditorView.editable.of(!readOnly),
        Prec.high(
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current(), true) },
            {
              key: 'F12',
              preventDefault: true,
              run: (target) => {
                const symbol = symbolAtPos(target, target.state.selection.main.head)
                if (symbol) onDefinitionRef.current(symbol)
                return true
              },
            },
          ]),
        ),
        EditorView.domEventHandlers({
          // Cmd/Ctrl-click, the same chord VS Code uses. A plain click has to
          // stay a plain click — this is an editor, not a viewer.
          mousedown: (event, target) => {
            if (!event.metaKey && !event.ctrlKey) return false
            const pos = target.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos === null) return false
            const symbol = symbolAtPos(target, pos)
            if (!symbol) return false
            event.preventDefault()
            onDefinitionRef.current(symbol)
            return true
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          const next = update.state.doc.toString()
          valueRef.current = next
          onChangeRef.current(next)
        }),
      ],
    })
    viewRef.current = view

    void languageForPath(path).then((extension) => {
      if (!disposed && extension) view.dispatch({ effects: language.reconfigure(extension) })
    })

    // Meta held down means the next click jumps; show that in the cursor.
    const trackModifier = (event: KeyboardEvent) =>
      view.contentDOM.classList.toggle('is-jumping', event.metaKey || event.ctrlKey)
    window.addEventListener('keydown', trackModifier)
    window.addEventListener('keyup', trackModifier)
    window.addEventListener('blur', () => view.contentDOM.classList.remove('is-jumping'))

    return () => {
      disposed = true
      window.removeEventListener('keydown', trackModifier)
      window.removeEventListener('keyup', trackModifier)
      viewRef.current = null
      view.destroy()
    }
  }, [path, readOnly])

  // Adopt a document that changed underneath us — a reload, a revert, or the
  // file being swapped without the path changing.
  useEffect(() => {
    const view = viewRef.current
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !navigation) return
    const line = view.state.doc.line(
      Math.min(Math.max(1, navigation.line), view.state.doc.lines),
    )
    const pos = Math.min(line.from + Math.max(0, (navigation.column ?? 1) - 1), line.to)
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
  }, [navigation?.token])

  return <div className="workspace-code-editor" ref={hostRef} />
}
