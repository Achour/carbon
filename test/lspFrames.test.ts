import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFrames } from '../src/main/lsp.ts'

const frame = (body: string): Buffer =>
  Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii'),
    Buffer.from(body, 'utf8')
  ])

test('reads one whole message', () => {
  const { messages, rest } = splitFrames(frame('{"id":1}'))
  assert.deepEqual(messages, ['{"id":1}'])
  assert.equal(rest.length, 0)
})

test('reads several messages out of one chunk', () => {
  const { messages, rest } = splitFrames(Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]))
  assert.deepEqual(messages, ['{"a":1}', '{"b":2}'])
  assert.equal(rest.length, 0)
})

test('holds a partial body until the rest arrives', () => {
  const whole = frame('{"hello":"world"}')
  const first = splitFrames(whole.subarray(0, whole.length - 5))
  assert.deepEqual(first.messages, [])
  const second = splitFrames(Buffer.concat([first.rest, whole.subarray(whole.length - 5)]))
  assert.deepEqual(second.messages, ['{"hello":"world"}'])
  assert.equal(second.rest.length, 0)
})

test('holds a partial header', () => {
  const { messages, rest } = splitFrames(Buffer.from('Content-Len', 'ascii'))
  assert.deepEqual(messages, [])
  assert.equal(rest.toString(), 'Content-Len')
})

test('counts bytes, not characters', () => {
  // Four UTF-16 code units, seven bytes: a length in characters would truncate
  // the body and desynchronize every message after it.
  const body = '{"s":"é😀"}'
  const { messages, rest } = splitFrames(Buffer.concat([frame(body), frame('{"next":1}')]))
  assert.deepEqual(messages, [body, '{"next":1}'])
  assert.equal(rest.length, 0)
})

test('tolerates extra headers and header case', () => {
  const body = '{"ok":1}'
  const buf = Buffer.concat([
    Buffer.from(
      `content-type: application/vscode-jsonrpc\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n`,
      'ascii'
    ),
    Buffer.from(body, 'utf8')
  ])
  assert.deepEqual(splitFrames(buf).messages, [body])
})

test('resyncs past a frame with no content-length instead of stalling', () => {
  const buf = Buffer.concat([Buffer.from('Bogus: 1\r\n\r\n', 'ascii'), frame('{"ok":1}')])
  assert.deepEqual(splitFrames(buf).messages, ['{"ok":1}'])
})
