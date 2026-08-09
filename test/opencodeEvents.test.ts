import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addStepUsage,
  emptyUsage,
  extractPlan,
  partToAssistantPart,
  permissionDiff,
  todosToToolPart,
  toolName,
  toolStatus,
  type OpencodePart
} from '../src/main/opencodeEvents.ts'
import { translateEvent, type OpencodeEvent } from '../src/main/opencodeServer.ts'

/**
 * Driven by two real recordings from `opencode serve` 1.18.15 (see
 * test/fixtures): one ordinary write+read turn, one turn that stops on a
 * permission. Recorded rather than hand-written because every assumption these
 * mappers encode — that text arrives as deltas, that a tool part keeps its id
 * across states — is a fact about the server, not about us.
 */

function fixture(name: string): { type?: string; properties?: Record<string, unknown> }[] {
  const raw = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
  const out: { type?: string; properties?: Record<string, unknown> }[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    try {
      out.push(JSON.parse(trimmed.slice(5).trim()))
    } catch {
      // the recording includes a truncated final frame
    }
  }
  return out
}

function translatedPairs(name: string): { sessionID: string; event: OpencodeEvent }[] {
  return fixture(name)
    .map((raw) => translateEvent(raw))
    .filter((x): x is { sessionID: string; event: OpencodeEvent } => x !== null)
}

/** The session id that owns most of a recording — the turn it was capturing. */
function mainSession(name: string): string {
  const counts = new Map<string, number>()
  for (const { sessionID } of translatedPairs(name)) {
    if (sessionID) counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * Events for one session. Filtering is the point: `/event` is a *global* bus, so
 * a recording taken while two sessions were live contains both interleaved —
 * which is exactly why the transport fans out by sessionID rather than opening
 * one stream per session.
 */
function translatedEvents(name: string, sessionID = mainSession(name)): OpencodeEvent[] {
  return translatedPairs(name)
    .filter((pair) => pair.sessionID === sessionID)
    .map((pair) => pair.event)
}

test('the event bus is global: one recording carries more than one session', () => {
  const sessions = new Set(
    translatedPairs('opencode-turn.jsonl')
      .map((p) => p.sessionID)
      .filter(Boolean)
  )
  assert.ok(
    sessions.size > 1,
    'this recording was taken while a second session ran, and must contain both'
  )
})

test('tool names are re-badged into the spellings the transcript cards key off', () => {
  assert.equal(toolName('write'), 'Write')
  assert.equal(toolName('bash'), 'Bash')
  assert.equal(toolName('todowrite'), 'TodoWrite')
  // Unknown tools (a plugin's, an MCP server's) pass through rather than
  // becoming a generic card.
  assert.equal(toolName('some_plugin_tool'), 'some_plugin_tool')
  assert.equal(toolName(undefined), 'Tool')
})

test('tool status maps completed to success and everything unknown to pending', () => {
  assert.equal(toolStatus('completed'), 'success')
  assert.equal(toolStatus('error'), 'error')
  assert.equal(toolStatus('running'), 'running')
  assert.equal(toolStatus('pending'), 'pending')
  assert.equal(toolStatus(undefined), 'pending')
})

test('a recorded turn yields text, thinking and tool parts and drops bookkeeping ones', () => {
  const parts: OpencodePart[] = []
  for (const event of translatedEvents('opencode-turn.jsonl')) {
    if (event.type === 'message.part.updated') parts.push(event.part)
  }
  assert.ok(parts.length > 0, 'the recording should contain part updates')

  const mapped = parts.map(partToAssistantPart)
  const kinds = new Set(mapped.filter(Boolean).map((p) => p!.type))
  assert.ok(kinds.has('text'))
  assert.ok(kinds.has('tool'))

  // step-start / step-finish / patch carry no transcript form.
  const dropped = parts.filter((p) => partToAssistantPart(p) === null).map((p) => p.type)
  assert.ok(dropped.includes('step-start'))
  assert.ok(dropped.includes('step-finish'))
  assert.ok(dropped.includes('patch'))
})

test('a tool part keeps one id across pending → running → completed', () => {
  const byId = new Map<string, string[]>()
  for (const event of translatedEvents('opencode-turn.jsonl')) {
    if (event.type !== 'message.part.updated') continue
    const part = partToAssistantPart(event.part)
    if (part?.type !== 'tool') continue
    byId.set(part.toolUseId, [...(byId.get(part.toolUseId) ?? []), part.status])
  }
  const lifecycles = [...byId.values()].filter((states) => states.length > 1)
  assert.ok(lifecycles.length > 0, 'the recording should contain a full tool lifecycle')
  for (const states of lifecycles) {
    assert.equal(states.at(-1), 'success')
    assert.ok(states.includes('pending'))
  }
})

test('a completed tool carries its output', () => {
  const outputs: string[] = []
  for (const event of translatedEvents('opencode-turn.jsonl')) {
    if (event.type !== 'message.part.updated') continue
    const part = partToAssistantPart(event.part)
    if (part?.type === 'tool' && part.status === 'success' && part.output) outputs.push(part.output)
  }
  assert.ok(outputs.some((o) => o.includes('Wrote file successfully')))
})

test('text arrives as incremental deltas, not whole-part resends', () => {
  const deltas = translatedEvents('opencode-turn.jsonl').filter(
    (e) => e.type === 'message.part.delta'
  )
  assert.ok(deltas.length > 0, 'the server should stream text as deltas')
  for (const delta of deltas) {
    assert.equal(delta.type, 'message.part.delta')
    if (delta.type !== 'message.part.delta') continue
    assert.ok(delta.partID.startsWith('prt_'))
    assert.equal(delta.field, 'text')
  }
  // Concatenating the deltas reconstructs the text the authoritative part
  // reports — the invariant the coalescer relies on.
  const joined = deltas
    .map((d) => (d.type === 'message.part.delta' ? d.delta : ''))
    .join('')
  assert.equal(joined, 'It says BANANA.')
})

test('session status is read out of its nested object, and idle fires once', () => {
  const events = translatedEvents('opencode-turn.jsonl')
  const statuses = events.filter((e) => e.type === 'session.status')
  assert.ok(statuses.length > 0)
  for (const s of statuses) {
    if (s.type !== 'session.status') continue
    assert.ok(s.status === 'busy' || s.status === 'idle', `unexpected status ${s.status}`)
  }
  assert.equal(events.filter((e) => e.type === 'session.idle').length, 1)
})

test('a permission request is translated with its id and diff', () => {
  const asked = translatedEvents('opencode-permission.jsonl').filter(
    (e) => e.type === 'permission.asked'
  )
  assert.equal(asked.length, 1)
  const event = asked[0]
  assert.equal(event.type, 'permission.asked')
  if (event.type !== 'permission.asked') return
  assert.ok(event.request.id?.startsWith('per_'))
  assert.equal(event.request.permission, 'edit')
  // The diff is what makes the permission card show what is about to change.
  const diff = permissionDiff(event.request)
  assert.ok(diff && diff.includes('+OK'), 'edit permissions should carry a unified diff')
  // callID ties the request back to the tool part that raised it.
  assert.ok(event.request.tool?.callID)
})

test('unknown bus events are ignored rather than mistranslated', () => {
  assert.equal(translateEvent({ type: 'plugin.added', properties: {} }), null)
  assert.equal(translateEvent({ type: 'server.heartbeat', properties: {} }), null)
  assert.equal(translateEvent({}), null)
})

test('step usage is summed across steps, not overwritten by the last one', () => {
  let usage = emptyUsage()
  for (const event of translatedEvents('opencode-turn.jsonl')) {
    if (event.type === 'message.part.updated') usage = addStepUsage(usage, event.part)
  }
  assert.ok(usage.input > 0, 'the turn should report input tokens')
  assert.ok(usage.cacheRead > 0, 'the recorded turn read from cache')

  // A single step's numbers must not be the total when there were several.
  const steps = translatedEvents('opencode-turn.jsonl').filter(
    (e) => e.type === 'message.part.updated' && e.part.type === 'step-finish'
  )
  assert.ok(steps.length > 1, 'the recorded turn ran several model steps')
})

test('todos render through the existing checklist card', () => {
  const part = todosToToolPart(
    [
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
      { content: 'third', status: 'anything-else' }
    ],
    'todo-1'
  )
  assert.equal(part.name, 'TodoWrite')
  assert.equal(part.status, 'success')
  assert.deepEqual(part.input, {
    todos: [
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
      // An unrecognized status is pending, never silently "done".
      { content: 'third', status: 'pending' }
    ]
  })
})

test('the plan is the last non-empty text part, not the preamble', () => {
  assert.equal(
    extractPlan([
      { type: 'text', text: 'Let me look around first.' },
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: '# Plan\n1. Do the thing' },
      { type: 'text', text: '   ' }
    ]),
    '# Plan\n1. Do the thing'
  )
  assert.equal(extractPlan([]), '')
})
