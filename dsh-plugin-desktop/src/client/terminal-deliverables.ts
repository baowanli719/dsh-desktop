/** Desktop adapter for files declared explicitly by terminal-based artifact skills. */

export interface ProducedPathLike {
  readonly seq: number
  readonly path: string
}

export interface DesktopTerminalDeliverablesAdapter {
  pathsForResult(toolName: string, content: unknown): readonly string[]
  reconcile(
    produced: readonly ProducedPathLike[],
    seq: number,
    paths: readonly string[],
  ): readonly ProducedPathLike[]
}

declare global {
  // The patched upstream deliverables client reads this optional adapter at
  // result-fold time. Keeping the seam optional preserves stock compatibility.
  var __GS_DESKTOP_TERMINAL_DELIVERABLES__: DesktopTerminalDeliverablesAdapter | undefined
}

const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g
const OUTPUT_LINE = /^\s*OUTPUT:\s*(.+?)\s*$/gim

/** Collect textual leaves from the nested tool-result content shape. */
function collectText(value: unknown, target: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, target)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Readonly<Record<string, unknown>>
  if (record.type === 'text' && typeof record.text === 'string') target.push(record.text)
  if (Array.isArray(record.content)) collectText(record.content, target)
}

/** Remove one balanced quote pair used by command-line output conventions. */
function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === last && (first === '"' || first === "'")) ? value.slice(1, -1).trim() : value
}

/** Parse explicit `OUTPUT: <path>.docx` declarations from a successful terminal result. */
export function terminalDocxOutputPaths(toolName: string, content: unknown): readonly string[] {
  if (!TERMINAL_TOOLS.has(toolName)) return []
  const fragments: string[] = []
  collectText(content, fragments)
  const seen = new Set<string>()
  const paths: string[] = []
  for (const fragment of fragments) {
    const text = fragment.replace(ANSI_ESCAPE, '')
    OUTPUT_LINE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = OUTPUT_LINE.exec(text)) !== null) {
      const path = unquote(match[1]?.trim() ?? '')
      if (!/\.docx$/i.test(path) || seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return (separator < 0 ? path : path.slice(separator + 1)).toLowerCase()
}

function directoryKey(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const directory = separator < 0 ? '' : path.slice(0, separator)
  return directory.replaceAll('\\', '/').toLowerCase()
}

/** Replace same-directory `report.json` intermediates with declared DOCX outputs. */
export function reconcileTerminalDocxOutputs(
  produced: readonly ProducedPathLike[],
  seq: number,
  paths: readonly string[],
): readonly ProducedPathLike[] {
  if (paths.length === 0) return produced
  const outputDirectories = new Set(paths.map(directoryKey))
  const next = produced.filter(item => basename(item.path) !== 'report.json'
    || !outputDirectories.has(directoryKey(item.path)))
  const existing = new Set(next.map(item => item.path))
  for (const path of paths) {
    if (existing.has(path)) continue
    existing.add(path)
    next.push({ seq, path })
  }
  return next
}

export const desktopTerminalDeliverablesAdapter: DesktopTerminalDeliverablesAdapter = {
  pathsForResult: terminalDocxOutputPaths,
  reconcile: reconcileTerminalDocxOutputs,
}

/** Publish the optional desktop seam for the upstream deliverables event fold. */
export function installDesktopTerminalDeliverables(): () => void {
  globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__ = desktopTerminalDeliverablesAdapter
  return () => {
    if (globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__ === desktopTerminalDeliverablesAdapter) {
      globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__ = undefined
    }
  }
}
