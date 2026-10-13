import * as React from 'react'

/**
 * Where a transcript is drawn. The desktop has a right panel, an editor, a
 * diff view and thread columns to open things in; the phone (`remote/`) draws
 * the same transcript components with none of those behind them, so a control
 * whose whole job is to open one is left out there rather than drawn dead.
 */
export interface TranscriptSurface {
  /** False on the phone: no file, diff, canvas or column to open. */
  panels: boolean
  /** Shows another chat — a delegate's — where there are no columns to open it in. */
  openChat?: (chatId: string) => void
  /** Shows a sub-agent's own transcript, in place of its thread column. */
  openAgent?: (parentChatId: string, toolUseId: string) => void
  /** Shows a canvas, in place of the right panel. */
  openCanvas?: (id: string) => void
}

const DESKTOP: TranscriptSurface = { panels: true }

export const TranscriptSurfaceContext = React.createContext<TranscriptSurface>(DESKTOP)

export function useTranscriptSurface(): TranscriptSurface {
  return React.useContext(TranscriptSurfaceContext)
}
