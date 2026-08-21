import * as React from 'react'
import hljs from 'highlight.js'
import type { FileContent } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { CodeSelectionLayer } from '@/components/CodeSelectionLayer'

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

const HIGHLIGHT_LIMIT = 200 * 1024
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
  /** Absolute path on disk. Without it, selected lines have no address to
   *  attach and the "Add to chat" pill stays off. */
  path?: string
  /** Project folder, so the Markdown preview can resolve relative paths. */
  cwd?: string | null
  /** For Markdown files: rendered preview or raw source. */
  mode?: 'preview' | 'source'
}): React.JSX.Element {
  const codeRef = React.useRef<HTMLPreElement | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const isMarkdown = !!name && MARKDOWN_RE.test(name)

  const highlighted = React.useMemo(() => {
    if (content?.kind !== 'text') return null
    if (content.content.length > HIGHLIGHT_LIMIT) return null
    try {
      if (content.language && hljs.getLanguage(content.language)) {
        return hljs.highlight(content.content, { language: content.language }).value
      }
    } catch {
      // fall through to plain text
    }
    return null
  }, [content])

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
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-6">
          <img
            src={content.dataUri}
            className="max-h-full max-w-full rounded-md border border-border"
            alt=""
          />
        </div>
      )
    case 'text': {
      if (isMarkdown && mode === 'preview') {
        return (
          <div className="h-full overflow-auto px-8 py-6">
            <Markdown text={content.content} cwd={cwd} className="mx-auto max-w-3xl" />
          </div>
        )
      }
      const lines = content.content.split('\n')
      return (
        <div
          ref={scrollRef}
          className="relative h-full select-text overflow-auto font-mono text-[length:var(--code-font-size)] leading-[1.65]"
        >
          <div className="flex min-w-max">
            {/* Unselectable so a drag that starts in the gutter yields the code
                alone — line numbers pasted into a prompt are noise the model has
                to parse back out. */}
            <pre className="sticky left-0 shrink-0 border-r border-border bg-card px-2.5 py-3 text-right text-muted-foreground/50 select-none">
              {lines.map((_, i) => `${i + 1}\n`).join('')}
            </pre>
            {highlighted ? (
              <pre
                ref={codeRef}
                className="flex-1 px-3.5 py-3"
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            ) : (
              <pre ref={codeRef} className="flex-1 px-3.5 py-3">
                {content.content}
              </pre>
            )}
          </div>
          <CodeSelectionLayer
            codeRef={codeRef}
            scrollRef={scrollRef}
            text={content.content}
            path={path}
            name={name}
            cwd={cwd}
            language={content.language}
          />
          {content.truncated && (
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              Preview truncated at 512 KB.
            </div>
          )}
        </div>
      )
    }
  }
})
