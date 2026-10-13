import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * Markdown for the phone. Not the desktop's `Markdown`: that one resolves
 * file links against the project, reads images off disk and opens the editor
 * — all through `window.api`, which a browser does not have — so it would
 * drag the desktop store into this bundle to do things a phone cannot. It
 * wears the desktop's `.markdown` styles and syntax colours, though, so a
 * reply reads the same on both screens.
 */
export const RemoteMarkdown = React.memo(function RemoteMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown text-[15.5px] leading-[1.6] select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
          // Local images are paths on the Mac; a phone cannot load them.
          img: ({ src, alt }) =>
            typeof src === 'string' && /^(https?:|data:)/.test(src) ? (
              <img src={src} alt={alt ?? ''} className="max-w-full rounded-lg" />
            ) : (
              <span className="text-muted-foreground">[image: {alt || src}]</span>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
