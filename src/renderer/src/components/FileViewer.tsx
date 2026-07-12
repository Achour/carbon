import * as React from 'react'
import hljs from 'highlight.js'
import type { FileContent } from '@shared/types'

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

const HIGHLIGHT_LIMIT = 200 * 1024

export const FileViewer = React.memo(function FileViewer({
  content
}: {
  content: FileContent | undefined
}): React.JSX.Element {
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
      const lines = content.content.split('\n')
      return (
        <div className="h-full select-text overflow-auto font-mono text-[length:var(--code-font-size)] leading-[1.65]">
          <div className="flex min-w-max">
            <pre className="sticky left-0 shrink-0 border-r border-border bg-card/60 px-2.5 py-3 text-right text-muted-foreground/50 backdrop-blur">
              {lines.map((_, i) => `${i + 1}\n`).join('')}
            </pre>
            {highlighted ? (
              <pre
                className="flex-1 px-3.5 py-3"
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            ) : (
              <pre className="flex-1 px-3.5 py-3">{content.content}</pre>
            )}
          </div>
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
