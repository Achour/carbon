import type { PreviewCommandResult, PreviewState } from '@shared/types'

/** The six tools Carbon's in-app preview exposes to every provider. */
export const PREVIEW_TOOL_NAMES = ['status', 'start', 'stop', 'navigate', 'screenshot', 'console'] as const

export type PreviewToolName = (typeof PREVIEW_TOOL_NAMES)[number]

export function isPreviewToolName(value: string): value is PreviewToolName {
  return (PREVIEW_TOOL_NAMES as readonly string[]).includes(value)
}

/** True for start/stop — the only preview tools that mutate the machine. */
export function isPreviewSideEffect(name: PreviewToolName): boolean {
  return name === 'start' || name === 'stop'
}

export const PREVIEW_TOOL_INFO: Record<
  PreviewToolName,
  { description: string; readOnly: boolean; url?: boolean }
> = {
  status: {
    description:
      'Get the dev-server preview status for this project: whether it is running and its local URL.',
    readOnly: true
  },
  start: {
    description:
      "Start this project's dev server (command auto-detected from package.json). Waits until the local URL is ready and opens the in-app preview. Use before screenshotting.",
    readOnly: false
  },
  stop: {
    description: "Stop this project's dev server.",
    readOnly: false
  },
  navigate: {
    description: 'Point the in-app preview browser at a URL (e.g. a specific route of the running app).',
    readOnly: false,
    url: true
  },
  screenshot: {
    description:
      'Capture a screenshot of the current preview page to see the running app as the user sees it. Start the dev server first if it is not running.',
    readOnly: true
  },
  console: {
    description:
      'Read recent console output and errors from the running preview app (browser console + dev-server errors).',
    readOnly: true
  }
}

/**
 * What a Grok session appends so the model knows the preview MCP is the
 * in-app browser, not a system browser it should ask the user to open.
 */
export const PREVIEW_SESSION_RULES =
  'You are running inside Carbon, a desktop GUI. The `preview` MCP server controls this project\'s in-app browser: `status`, `start` (dev server + open the preview), `stop`, `navigate` (a URL), `screenshot` (the page as the user sees it), and `console` (browser + dev-server errors). Use those tools to verify UI changes. Do not ask the user to open a browser or take a screenshot for you.'

export type PreviewToolHost = {
  state(cwd: string): PreviewState
  startAndWait(cwd: string): Promise<PreviewState>
  stop(cwd: string): PreviewState
  navigate(cwd: string, url: string): Promise<PreviewCommandResult>
  screenshot(cwd: string): Promise<string | null>
  recentConsole(cwd: string): string
}

export type PreviewToolResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType: string }

export async function runPreviewTool(
  preview: PreviewToolHost,
  cwd: string,
  name: PreviewToolName,
  input: { url?: string } = {}
): Promise<PreviewToolResult> {
  switch (name) {
    case 'status':
      return { kind: 'text', text: JSON.stringify(preview.state(cwd)) }
    case 'start':
      return { kind: 'text', text: JSON.stringify(await preview.startAndWait(cwd)) }
    case 'stop':
      return { kind: 'text', text: JSON.stringify(preview.stop(cwd)) }
    case 'navigate': {
      const url = input.url?.trim()
      if (!url) return { kind: 'text', text: 'Failed to navigate: url is required.' }
      const res = await preview.navigate(cwd, url)
      return { kind: 'text', text: res.ok ? `Navigated to ${url}` : `Failed to navigate: ${res.error ?? 'unknown'}` }
    }
    case 'screenshot': {
      const data = await preview.screenshot(cwd)
      if (!data) {
        return {
          kind: 'text',
          text: 'No preview is open to screenshot. Start the dev server (preview.start) or navigate first.'
        }
      }
      return { kind: 'image', data, mimeType: 'image/png' }
    }
    case 'console':
      return { kind: 'text', text: preview.recentConsole(cwd) || 'No console output captured yet.' }
  }
}
