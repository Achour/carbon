import * as React from 'react'
import type { FileContent } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { CodeEditor } from '@/components/CodeEditor'
import { ConflictBar } from '@/components/ConflictBar'
import { ImageView } from '@/components/ImageView'

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
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
        return (
          <div className="h-full overflow-auto px-8 py-6">
            <Markdown text={content.content} cwd={cwd} className="mx-auto max-w-3xl" />
          </div>
        )
      }
      return (
        <div className="flex h-full min-h-0 flex-col">
          <ConflictBar path={path} />
          <div className="min-h-0 flex-1">
            <CodeEditor content={content} path={path} />
          </div>
        </div>
      )
    }
  }
})
