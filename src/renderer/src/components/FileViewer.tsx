import * as React from 'react'
import type { FileContent } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { ConflictBar } from '@/components/ConflictBar'
import { ImageView } from '@/components/ImageView'
import { cn } from '@/lib/utils'
import { splitFrontmatter, type FrontmatterPair } from '@/lib/frontmatter'

/**
 * CodeMirror — the editor itself plus its language, lint, autocomplete, search
 * and LSP packages — is ~750 KB, and none of it is reachable until a file is
 * opened in a text tab. Statically imported it was evaluated before first paint
 * for every session, including every one that never leaves the transcript.
 *
 * `preloadHeavy` fetches this chunk on the first idle frame after launch, so by
 * the time anyone clicks a file it is already in memory and the Suspense
 * fallback below never appears. Lazily loading a surface *without* preloading it
 * trades a slow launch for a visible hitch on first open, which is the same
 * cost moved somewhere more annoying.
 */
const CodeEditor = React.lazy(() =>
  import('@/components/CodeEditor').then((m) => ({ default: m.CodeEditor }))
)

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * A file's YAML frontmatter, drawn as the key/value table it is. `border-separate`
 * rather than `border-collapse` because a collapsed table ignores the rounding on
 * its own corners; the borders therefore live on the cells.
 */
function FrontmatterTable({ pairs }: { pairs: FrontmatterPair[] }): React.JSX.Element {
  return (
    <table className="mb-6 w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-lg border border-border text-[13px] leading-[1.55]">
      <tbody>
        {pairs.map((p, i) => (
          <tr key={i}>
            <td
              className={cn(
                'w-[26%] border-r border-border bg-muted/25 px-3 py-2 align-top font-medium break-words text-muted-foreground',
                i > 0 && 'border-t'
              )}
            >
              {p.key}
            </td>
            <td className={cn('px-3 py-2 align-top break-words whitespace-pre-wrap', i > 0 && 'border-t border-border')}>
              {p.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export const MARKDOWN_RE = /\.(md|markdown|mdx)$/i

export const FileViewer = React.memo(function FileViewer({
  content,
  name,
  path,
  cwd = null,
  mode = 'preview'
}: {
  content: FileContent | undefined
  /** File name, used to detect Markdown for the preview. */
  name?: string
  /**
   * Absolute path on disk — the buffer key, the save target and the LSP document
   * uri. Required: `RightPanel` is the single place tab kind is decided, and it
   * routes Untitled placeholders to `UntitledView` before reaching here.
   */
  path: string
  /** Project folder, so the Markdown preview can resolve relative paths. */
  cwd?: string | null
  /** For Markdown files: rendered preview or raw source. */
  mode?: 'preview' | 'source'
}): React.JSX.Element {
  const isMarkdown = !!name && MARKDOWN_RE.test(name)
  // Split once per document rather than per render: the preview re-renders
  // with the panel (a resize, a tab switch), and the split walks the text.
  const text = content?.kind === 'text' ? content.content : null
  const fm = React.useMemo(
    () => (isMarkdown && text !== null ? splitFrontmatter(text) : null),
    [isMarkdown, text]
  )

  if (!content) return <Placeholder>Loading…</Placeholder>

  switch (content.kind) {
    case 'error':
      return <Placeholder>Could not open file: {content.message}</Placeholder>
    case 'binary':
      return <Placeholder>Binary file ({(content.size / 1024).toFixed(1)} KB)</Placeholder>
    case 'too-large':
      return (
        <Placeholder>File is too large to preview ({(content.size / 1024 / 1024).toFixed(1)} MB)</Placeholder>
      )
    case 'image':
      return <ImageView src={content.dataUri} alt={name} />
    case 'text': {
      if (isMarkdown && mode === 'preview') {
        // Frontmatter is split off before parsing: to CommonMark the opening
        // `---` is a thematic break and the closing one makes the keys above it
        // a setext H2, so the whole block rendered as one giant bold heading.
        return (
          <div className="h-full overflow-auto px-8 py-6">
            <div className="mx-auto max-w-3xl">
              {fm && <FrontmatterTable pairs={fm.pairs} />}
              <Markdown text={fm ? fm.body : content.content} cwd={cwd} />
            </div>
          </div>
        )
      }
      return (
        <div className="flex h-full min-h-0 flex-col">
          <ConflictBar path={path} />
          <div className="min-h-0 flex-1">
            {/* No spinner: the chunk is preloaded and this resolves in a frame,
                so a flash of "Loading…" would be the only thing anyone ever saw
                of it. An empty pane for one frame reads as the file opening. */}
            <React.Suspense fallback={null}>
              <CodeEditor content={content} path={path} />
            </React.Suspense>
          </div>
        </div>
      )
    }
  }
})
