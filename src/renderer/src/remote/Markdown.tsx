import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown for the phone. Not the desktop's `Markdown`: that one resolves
 * file links against the project, reads images off disk and opens the editor
 * — all through `window.api`, which a browser does not have — so it would
 * drag the desktop store into this bundle to do things a phone cannot.
 * Links open in a new tab; everything else is plain GFM.
 */
export const RemoteMarkdown = React.memo(function RemoteMarkdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
          // Local images are paths on the Mac; a phone cannot load them.
          img: ({ src, alt }) =>
            typeof src === 'string' && /^(https?:|data:)/.test(src) ? (
              <img src={src} alt={alt ?? ''} />
            ) : (
              <span className="md-missing">[image: {alt || src}]</span>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
