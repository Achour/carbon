import { Worker } from 'node:worker_threads'
import type { ChatSearchResult } from '@shared/types'

/**
 * The main process's handle on the search thread (`searchWorker.ts`): one
 * worker, started once, answering queries by message. A worker that dies is
 * started again on the next query; a query in flight when it dies answers
 * empty rather than hanging.
 */
export class ChatSearch {
  private worker: Worker | null = null
  private pending = new Map<number, (r: ChatSearchResult) => void>()
  private next = 0

  constructor(
    private script: string,
    private chatsDb: string,
    private indexDb: string
  ) {}

  start(): void {
    if (this.worker) return
    const worker = new Worker(this.script, { workerData: { chatsDb: this.chatsDb, indexDb: this.indexDb } })
    // Never what keeps the app alive.
    worker.unref()
    worker.on('message', (m: { id: number } & ChatSearchResult) => {
      this.pending.get(m.id)?.({ hits: m.hits, complete: m.complete })
      this.pending.delete(m.id)
    })
    const lost = (err?: unknown): void => {
      if (err) console.warn('[search] worker stopped:', err)
      if (this.worker !== worker) return
      this.worker = null
      for (const answer of this.pending.values()) answer({ hits: [], complete: false })
      this.pending.clear()
    }
    worker.on('error', lost)
    worker.on('exit', () => lost())
    this.worker = worker
  }

  search(query: string, limit = 30): Promise<ChatSearchResult> {
    if (!query.trim()) return Promise.resolve({ hits: [], complete: true })
    this.start()
    const id = ++this.next
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker!.postMessage({ id, query, limit })
    })
  }

  dispose(): void {
    void this.worker?.terminate()
    this.worker = null
  }
}
