import type { PreviewState } from '@shared/types'
import { PREVIEW_DEVICES, previewDevice, type PreviewViewportPatch } from '../shared/previewDevices.ts'

/**
 * The tools Carbon's in-app preview exposes to every provider.
 *
 * Three groups: the dev server (`status`/`start`/`stop`), reading the page
 * (`snapshot`, `screenshot`, `console`, `network`, `wait_for`) and acting on it
 * (`navigate`, `click`, `type`, `press`, `scroll`, `evaluate`, `resize`). The
 * acting half is what turns the preview from something the agent can look at
 * into something it can *use* — log in, fill the form, open the menu, check
 * the result — which is what "verify the UI change" actually needs.
 */
export const PREVIEW_TOOL_NAMES = [
  'status',
  'start',
  'stop',
  'navigate',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'wait_for',
  'evaluate',
  'resize',
  'console',
  'network'
] as const

export type PreviewToolName = (typeof PREVIEW_TOOL_NAMES)[number]

export function isPreviewToolName(value: string): value is PreviewToolName {
  return (PREVIEW_TOOL_NAMES as readonly string[]).includes(value)
}

/**
 * What a tool changes, which is what plan mode asks. `server` starts or stops
 * a process; `page` acts on the running app — a click can submit a form, and
 * a dev app's form writes to a real dev database — so both wait for an
 * approved plan. Reading, scrolling, resizing and navigating change nothing
 * the user would have to undo.
 */
const SIDE_EFFECT: Partial<Record<PreviewToolName, 'server' | 'page'>> = {
  start: 'server',
  stop: 'server',
  click: 'page',
  type: 'page',
  press: 'page',
  evaluate: 'page'
}

/** True for the tools refused in plan mode (see `SIDE_EFFECT`). */
export function isPreviewSideEffect(name: PreviewToolName): boolean {
  return SIDE_EFFECT[name] !== undefined
}

/**
 * Plan-mode deny. Asked at the call — the session's registered context carries
 * a `plan()` getter — rather than pinned when the server was wired, so a mode
 * change between turns lands without a respawn.
 */
export function previewPlanBlock(name: string, plan: boolean): string | null {
  if (!plan || !isPreviewToolName(name)) return null
  const kind = SIDE_EFFECT[name]
  if (kind === 'server') {
    return 'Starting or stopping the dev server is a side effect and is not allowed in plan mode. Note it in the plan — it can run once the plan is approved.'
  }
  if (kind === 'page') {
    return 'Clicking, typing and running scripts in the preview can change the app\'s data, so they are not allowed in plan mode. Read the page with preview_snapshot or preview_screenshot instead, and note the interaction in the plan.'
  }
  return null
}

export type PreviewParamType = 'string' | 'boolean' | 'number'

export interface PreviewParam {
  type: PreviewParamType
  description: string
  required?: boolean
  enum?: readonly string[]
}

const TARGET: Record<'ref' | 'selector' | 'text', PreviewParam> = {
  ref: { type: 'string', description: 'Element ref from preview_snapshot, e.g. "e12". Preferred.' },
  selector: { type: 'string', description: 'CSS selector, when no ref fits.' },
  text: { type: 'string', description: 'Visible text or accessible name of the element, when no ref fits.' }
}

const DEVICE_IDS = ['fill', ...PREVIEW_DEVICES.map((d) => d.id)] as const

/**
 * One table, three derivations: the zod shape Claude's in-process server
 * takes, the JSON Schema Codex, Grok and Antigravity read from `tools/list`,
 * and the coercion of a model's raw arguments (`carbonToolInput`). Hand-copying
 * those drifted before — see `docs/canvas.md` — so a parameter is described
 * here and nowhere else.
 */
export const PREVIEW_TOOL_INFO: Record<
  PreviewToolName,
  { description: string; readOnly: boolean; params: Record<string, PreviewParam> }
> = {
  status: {
    description:
      "The dev-server preview's status for this project: whether it is running and its URL, plus any other local servers found running in this project.",
    readOnly: true,
    params: {}
  },
  start: {
    description:
      "Start this project's dev server (command auto-detected) and open it in the in-app preview. If a server for this project is already running — e.g. started in the user's terminal — it is used instead of starting a second one. Waits until the URL is ready.",
    readOnly: false,
    params: {}
  },
  stop: {
    description:
      "Stop this project's dev server (only one Carbon started). The server is shared with every other chat using the preview on this project, so it is not stopped while another one is using it unless force is true.",
    readOnly: false,
    params: {
      force: { type: 'boolean', description: 'Stop it even though another chat is using it.' }
    }
  },
  navigate: {
    description:
      'Load a URL in the in-app preview (e.g. a route of the running app), or go back/forward/reload. Opens the preview if it is not open. Each chat has its own preview tab on the shared dev server, so other agents testing at the same time never move your page.',
    readOnly: false,
    params: {
      url: { type: 'string', description: 'The URL to load.' },
      action: {
        type: 'string',
        description: 'Instead of a URL: "back", "forward" or "reload".',
        enum: ['back', 'forward', 'reload']
      }
    }
  },
  snapshot: {
    description:
      'Read the preview page as structured text: headings, text, and every interactive element with a ref (e.g. [ref=e12]) plus its value and state, then any new console errors and failed requests. Use the refs with click/type/scroll/wait_for. Prefer this over a screenshot to read or act on the page; use a screenshot to judge how it looks.',
    readOnly: true,
    params: {}
  },
  screenshot: {
    description:
      'Capture the preview page as the user sees it. full_page captures the whole scrollable page instead of the viewport. Start the dev server first if it is not running.',
    readOnly: true,
    params: {
      full_page: { type: 'boolean', description: 'Capture the whole page rather than the visible viewport.' }
    }
  },
  click: {
    description:
      'Click an element in the preview with a real mouse event (scrolled into view first), then report what changed: navigation, new console errors, failed requests. Target it by ref (from preview_snapshot), selector or text — or x/y viewport coordinates.',
    readOnly: false,
    params: {
      ...TARGET,
      x: { type: 'number', description: 'Viewport x in CSS pixels, instead of a target.' },
      y: { type: 'number', description: 'Viewport y in CSS pixels, instead of a target.' },
      double: { type: 'boolean', description: 'Double-click.' },
      button: { type: 'string', description: 'Mouse button (default left).', enum: ['left', 'right', 'middle'] }
    }
  },
  type: {
    description:
      'Type text into a field in the preview. Replaces what the field holds unless append is set; picks the matching option of a <select>. Targets the focused element when no ref/selector is given.',
    readOnly: false,
    params: {
      text: { type: 'string', description: 'The text to type.', required: true },
      ref: TARGET.ref,
      selector: TARGET.selector,
      append: { type: 'boolean', description: 'Add to the existing value instead of replacing it.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' }
    }
  },
  press: {
    description:
      'Press a key or shortcut in the preview, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Shift+Tab", "Meta+K". Goes to the focused element, or to ref/selector after focusing it.',
    readOnly: false,
    params: {
      key: { type: 'string', description: 'Key name or combo, e.g. "Enter" or "Control+A".', required: true },
      ref: TARGET.ref,
      selector: TARGET.selector
    }
  },
  scroll: {
    description:
      'Scroll the preview: bring an element into view (ref/selector/text), scroll by dy/dx pixels (with a target, scrolls inside it), or jump to the top or bottom.',
    readOnly: true,
    params: {
      ...TARGET,
      dy: { type: 'number', description: 'Pixels to scroll down (negative scrolls up).' },
      dx: { type: 'number', description: 'Pixels to scroll right (negative scrolls left).' },
      to: { type: 'string', description: 'Jump to the top or bottom of the page.', enum: ['top', 'bottom'] }
    }
  },
  wait_for: {
    description:
      'Wait until text, an element or a ref appears in the preview (or, with gone, disappears) — after an action that loads data or animates. Up to timeout_ms (default 5000, max 30000).',
    readOnly: true,
    params: {
      text: { type: 'string', description: 'Text to wait for anywhere on the page.' },
      selector: { type: 'string', description: 'CSS selector of a visible element to wait for.' },
      ref: { type: 'string', description: 'Element ref from preview_snapshot — most useful with gone, to wait for it to leave.' },
      gone: { type: 'boolean', description: 'Wait for it to disappear instead.' },
      timeout_ms: { type: 'number', description: 'Maximum wait in milliseconds.' }
    }
  },
  evaluate: {
    description:
      'Run JavaScript in the preview page and return its result as JSON (promises are awaited; a function is called). Only runs on local dev-server pages. Use it to read state the snapshot does not show, not to click — use preview_click for that.',
    readOnly: false,
    params: {
      expression: { type: 'string', description: 'A JavaScript expression, statements, or a function to call.', required: true }
    }
  },
  resize: {
    description:
      'Set the preview viewport: a device preset (phones/tablets emulate touch and a mobile user agent), a custom width/height, or "fill" to fit the pane. color_scheme emulates prefers-color-scheme. The user sees the same viewport.',
    readOnly: true,
    params: {
      device: { type: 'string', description: 'Preset, or "fill".', enum: DEVICE_IDS },
      width: { type: 'number', description: 'Custom viewport width in CSS pixels.' },
      height: { type: 'number', description: 'Custom viewport height in CSS pixels.' },
      rotate: { type: 'boolean', description: 'Landscape instead of portrait.' },
      color_scheme: {
        type: 'string',
        description: 'Emulated prefers-color-scheme; "system" stops emulating.',
        enum: ['light', 'dark', 'system']
      }
    }
  },
  console: {
    description:
      'Console output from the preview page that is new since your last read — errors, warnings, logs, uncaught exceptions — plus recent dev-server errors. all=true returns the recent history instead, debug lines included.',
    readOnly: true,
    params: {
      all: { type: 'boolean', description: 'Return recent history rather than only what is new.' }
    }
  },
  network: {
    description:
      'Requests the preview page made since your last read: method, URL, status, timing. failed_only narrows to failures and 4xx/5xx (with a snippet of each failed API response body); filter matches the URL.',
    readOnly: true,
    params: {
      failed_only: { type: 'boolean', description: 'Only failed requests and error statuses.' },
      filter: { type: 'string', description: 'Substring the URL must contain.' },
      all: { type: 'boolean', description: 'Return recent history rather than only what is new.' }
    }
  }
}

/** Every parameter name any preview tool declares. A name means one thing in every tool that takes it. */
export const PREVIEW_PARAMS: Record<string, PreviewParam> = Object.fromEntries(
  Object.values(PREVIEW_TOOL_INFO).flatMap((info) => Object.entries(info.params))
)

/**
 * A raw argument as its declared type, or undefined when it cannot be one.
 * Both boundaries use it — the HTTP providers through `carbonToolInput`, and
 * Claude's zod schema as a preprocess — so `"800"` for a number, `"true"` for
 * a boolean, or an enum value outside its list mean the same thing whichever
 * provider sent them.
 */
export function coercePreviewParam(p: PreviewParam, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (p.type === 'string') {
    if (typeof value !== 'string') return undefined
    return p.enum && !p.enum.includes(value) ? undefined : value
  }
  if (p.type === 'boolean') {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    return undefined
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * What a session appends so the model knows the preview tools are the in-app
 * browser, not a system browser it should ask the user to open. The tools live
 * on the one `carbon` MCP server, beside the canvas ones.
 */
export const PREVIEW_SESSION_RULES =
  "You are running inside Carbon, a desktop GUI. The `carbon` MCP server drives this project's in-app browser preview: `preview_start` (dev server + open the preview), `preview_navigate`, `preview_snapshot` (the page as text with element refs), `preview_click` / `preview_type` / `preview_press` / `preview_scroll` (act on those refs), `preview_wait_for`, `preview_screenshot`, `preview_resize` (device sizes, dark mode), `preview_console` / `preview_network`, and `preview_evaluate`. Use them to check UI changes yourself — read with a snapshot, act on refs, confirm with a screenshot. Do not ask the user to open a browser or take a screenshot for you."

/** The arguments any preview tool can receive, already coerced. */
export type PreviewToolInput = {
  url?: string
  action?: string
  full_page?: boolean
  force?: boolean
  ref?: string
  selector?: string
  text?: string
  x?: number
  y?: number
  double?: boolean
  button?: string
  append?: boolean
  submit?: boolean
  key?: string
  dy?: number
  dx?: number
  to?: string
  gone?: boolean
  timeout_ms?: number
  expression?: string
  device?: string
  width?: number
  height?: number
  rotate?: boolean
  color_scheme?: string
  all?: boolean
  failed_only?: boolean
  filter?: string
}

/** The page operations, answered by `PreviewManager` over CDP. */
export type PreviewPageOp = Exclude<PreviewToolName, 'status' | 'start' | 'stop' | 'screenshot'>

export type PreviewToolHost = {
  /** The state plus any other servers found for the project. */
  status(cwd: string, caller: string): Promise<string>
  startAndWait(cwd: string): Promise<PreviewState>
  /** `caller` set and another chat using the server: refused unless `force`. */
  stop(cwd: string, caller: string, force?: boolean): PreviewState
  /** `caller` is the chat whose own pane is shot (see `pickPreviewPane`). */
  screenshot(cwd: string, caller: string, opts: { fullPage?: boolean }): Promise<string | { error: string }>
  /** Every page op answers in text; `caller` scopes the console/network cursors. */
  page(cwd: string, caller: string, op: PreviewPageOp, input: PreviewToolInput): Promise<string>
}

export type PreviewToolResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType: string }

export async function runPreviewTool(
  preview: PreviewToolHost,
  cwd: string,
  name: PreviewToolName,
  input: PreviewToolInput = {},
  options: { caller?: string } = {}
): Promise<PreviewToolResult> {
  const caller = options.caller ?? cwd
  switch (name) {
    case 'status':
      return { kind: 'text', text: await preview.status(cwd, caller) }
    case 'start':
      return { kind: 'text', text: JSON.stringify(await preview.startAndWait(cwd)) }
    case 'stop':
      return { kind: 'text', text: JSON.stringify(preview.stop(cwd, caller, input.force === true)) }
    case 'screenshot': {
      const shot = await preview.screenshot(cwd, caller, { fullPage: input.full_page === true })
      if (typeof shot !== 'string') return { kind: 'text', text: shot.error }
      return { kind: 'image', data: shot, mimeType: 'image/png' }
    }
    case 'navigate':
      if (!input.url?.trim() && !input.action) {
        return { kind: 'text', text: 'Failed to navigate: give a url, or an action ("back", "forward", "reload").' }
      }
      break
    case 'type':
      if (typeof input.text !== 'string') return { kind: 'text', text: 'text is required.' }
      break
    case 'press':
      if (!input.key?.trim()) return { kind: 'text', text: 'key is required (e.g. "Enter").' }
      break
    case 'evaluate':
      if (!input.expression?.trim()) return { kind: 'text', text: 'expression is required.' }
      break
    case 'wait_for':
      if (!input.text && !input.selector && !input.ref) return { kind: 'text', text: 'Give text, a selector or a ref to wait for.' }
      break
  }
  return { kind: 'text', text: await preview.page(cwd, caller, name as PreviewPageOp, input) }
}

/** `preview_resize`'s arguments as a patch on the pane's viewport. */
export function viewportPatch(input: PreviewToolInput): PreviewViewportPatch | { error: string } {
  const patch: PreviewViewportPatch = {}
  if (input.device) {
    if (input.device === 'fill') patch.device = 'fill'
    else {
      const d = previewDevice(input.device)
      if (!d) return { error: `Unknown device "${input.device}". Use "fill" or one of: ${PREVIEW_DEVICES.map((x) => x.id).join(', ')}.` }
      patch.device = d.id
    }
  } else if (input.width || input.height) {
    if (!input.width || !input.height) return { error: 'Give both width and height for a custom viewport.' }
    patch.device = 'custom'
    patch.width = input.width
    patch.height = input.height
  }
  if (input.rotate !== undefined) patch.rotated = input.rotate
  if (input.color_scheme) patch.colorScheme = input.color_scheme === 'system' ? null : (input.color_scheme as 'light' | 'dark')
  if (!Object.keys(patch).length) return { error: 'Say what to change: device, width and height, rotate, or color_scheme.' }
  return patch
}

/**
 * Arguments a preview tool was given that cannot be what it declares — an
 * enum value outside its list, `"lots"` for a number. Refused at the HTTP
 * boundary the way Claude's zod schema refuses them, rather than dropped
 * there and refused here: `button: "thumb"` must not become a left click on
 * one provider and an error on another.
 */
export function previewArgErrors(name: PreviewToolName, raw: unknown): string[] {
  const input = (raw ?? {}) as Record<string, unknown>
  const errors: string[] = []
  for (const [key, param] of Object.entries(PREVIEW_TOOL_INFO[name].params)) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (coercePreviewParam(param, value) === undefined) {
      errors.push(
        `${key}: expected ${param.enum ? `one of ${param.enum.join(', ')}` : `a ${param.type}`}, got ${JSON.stringify(value)}`
      )
    }
  }
  return errors
}
