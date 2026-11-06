/**
 * Cuts a stream of text chunks into lines, handing each non-empty one to
 * `onLine`.
 *
 * The unfinished tail is kept as fragments and joined once, when its newline
 * arrives. Prepending it to every chunk and searching from the start instead
 * re-scans the whole of a long line on each chunk — quadratic, and a JSONL
 * record carrying an inline image or a large tool result runs to megabytes
 * (a 16 MB line was ~220 ms of main thread in 64 KB chunks).
 */
export class LineSplitter {
  private pending: string[] = []
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  push(chunk: string): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf('\n', start)
      if (nl === -1) break
      let line = chunk.slice(start, nl)
      if (this.pending.length > 0) {
        this.pending.push(line)
        line = this.pending.join('')
        this.pending = []
      }
      if (line) this.onLine(line)
      start = nl + 1
    }
    if (start < chunk.length) this.pending.push(chunk.slice(start))
  }

  /** The last line, when the text does not end with a newline. */
  end(): void {
    if (this.pending.length === 0) return
    const line = this.pending.join('')
    this.pending = []
    if (line) this.onLine(line)
  }
}
