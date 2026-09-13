/**
 * One overlay serving quick-open (Mod-p), project-wide find (Mod-shift-f), and
 * the "which definition did you mean?" list. All three are an input over a
 * keyboard-navigable result list, so they are one component rather than three
 * near-copies.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type WorkspaceGrepMatch } from '../lib/api'
import { IconSearch } from './icons'

export type PaletteMode = 'files' | 'grep' | 'results'

/** A file hit has no line; a content hit does. `line` drives the jump. */
export type PaletteResult = {
  path: string
  relativePath: string
  line?: number
  column?: number
  preview?: string
}

const DEBOUNCE_MS = 180

export function EditorPalette({
  root,
  mode,
  results,
  title,
  onPick,
  onClose,
}: {
  root: string
  mode: PaletteMode
  results?: PaletteResult[]
  title?: string
  onPick: (result: PaletteResult) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PaletteResult[]>(results ?? [])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const listRef = useRef<HTMLUListElement | null>(null)

  const placeholder =
    mode === 'files' ? 'Go to file…' : mode === 'grep' ? 'Find in project…' : ''

  useEffect(() => {
    if (mode === 'results') return
    const needle = query.trim()
    if (mode === 'grep' && !needle) {
      setItems([])
      setTruncated(false)
      return
    }
    setLoading(true)
    // Every keystroke would otherwise spawn a grep; the last one is the only
    // answer anyone wants, and `stale` drops replies that lost the race.
    let stale = false
    const timer = window.setTimeout(async () => {
      const response =
        mode === 'files'
          ? await api.workspaceSearch(root, needle)
          : await api.workspaceGrep(root, needle, { caseSensitive, wholeWord, regex })
      if (stale) return
      setLoading(false)
      setActive(0)
      setTruncated(Boolean((response as { truncated?: boolean }).truncated))
      setItems(
        response.ok
          ? ((response.matches ?? []) as (WorkspaceGrepMatch | PaletteResult)[]).map((match) => ({
              path: match.path,
              relativePath: match.relativePath,
              line: 'line' in match ? match.line : undefined,
              column: 'column' in match ? match.column : undefined,
              preview: 'preview' in match ? match.preview : undefined,
            }))
          : [],
      )
    }, DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [root, mode, query, caseSensitive, wholeWord, regex])

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') return onClose()
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, items.length - 1))
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = items[active]
      if (picked) onPick(picked)
    }
  }

  const heading = useMemo(() => {
    if (title) return title
    if (loading) return 'Searching…'
    if (!items.length) return mode === 'grep' && !query.trim() ? '' : 'No matches'
    return `${items.length}${truncated ? '+' : ''} ${items.length === 1 ? 'match' : 'matches'}`
  }, [title, loading, items.length, truncated, mode, query])

  return (
    <div className="editor-palette" onClick={onClose} role="presentation">
      <div
        className="editor-palette__panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {mode !== 'results' && (
          <div className="editor-palette__head">
            <IconSearch size={14} />
            <input
              autoFocus
              value={query}
              spellCheck={false}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(event) => setQuery(event.target.value)}
            />
            {mode === 'grep' && (
              <div className="editor-palette__toggles">
                <Toggle label="Aa" title="Match case" on={caseSensitive} onChange={setCaseSensitive} />
                <Toggle label="ab" title="Whole word" on={wholeWord} onChange={setWholeWord} />
                <Toggle label=".*" title="Regular expression" on={regex} onChange={setRegex} />
              </div>
            )}
          </div>
        )}
        {heading && <div className="editor-palette__count">{heading}</div>}
        <ul className="editor-palette__list" ref={listRef} role="listbox">
          {items.map((item, index) => (
            <li key={`${item.path}:${item.line ?? 0}:${index}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(item)}
              >
                <span className="editor-palette__path">
                  {item.relativePath}
                  {item.line !== undefined && <em>:{item.line}</em>}
                </span>
                {item.preview !== undefined && (
                  <span className="editor-palette__preview">{item.preview.trim().slice(0, 200)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Toggle({
  label,
  title,
  on,
  onChange,
}: {
  label: string
  title: string
  on: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={on ? 'is-on' : undefined}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  )
}
