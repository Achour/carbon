import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapProviderList,
  opencodeModelId,
  parseOpencodeModelId
} from '../src/main/opencodeModels.ts'
import { OPENCODE_DEFAULT_MODEL, providerForModel } from '../src/shared/types.ts'

test('a model id round-trips through the codec', () => {
  const id = opencodeModelId('openai', 'gpt-5.6-luna')
  assert.equal(id, 'opencode:openai/gpt-5.6-luna')
  assert.deepEqual(parseOpencodeModelId(id), { providerID: 'openai', modelID: 'gpt-5.6-luna' })
})

test('a model id containing slashes splits on the first one only', () => {
  // providerIDs never contain a slash; model ids sometimes do, and a
  // last-slash split would shred them.
  const id = opencodeModelId('openrouter', 'anthropic/claude-sonnet-5')
  assert.deepEqual(parseOpencodeModelId(id), {
    providerID: 'openrouter',
    modelID: 'anthropic/claude-sonnet-5'
  })
})

test('the sentinel and malformed ids parse to null, meaning "do not pin a model"', () => {
  assert.equal(parseOpencodeModelId(OPENCODE_DEFAULT_MODEL), null)
  assert.equal(parseOpencodeModelId(undefined), null)
  assert.equal(parseOpencodeModelId(''), null)
  assert.equal(parseOpencodeModelId('gpt-5.6-luna'), null, 'an unprefixed id is not ours')
  assert.equal(parseOpencodeModelId('opencode:'), null)
  assert.equal(parseOpencodeModelId('opencode:openai'), null, 'no model half')
  assert.equal(parseOpencodeModelId('opencode:/gpt-5'), null, 'no provider half')
})

test('an opencode id routes to opencode without any live catalog', () => {
  // This is why the ids are prefixed at all: providerForModel falls back to
  // 'claude', so a bare id would be misrouted at startup and on every path that
  // runs before the picker has loaded.
  assert.equal(providerForModel('opencode:openai/gpt-5.6-luna'), 'opencode')
  assert.equal(providerForModel(OPENCODE_DEFAULT_MODEL), 'opencode')
  assert.equal(providerForModel('claude-opus-5'), 'claude')
})

const PROVIDERS = {
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      models: {
        'deepseek-v4-flash-free': {
          id: 'deepseek-v4-flash-free',
          name: 'DeepSeek V4 Flash (free)',
          limit: { context: 128_000, output: 8_000 }
        }
      }
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: {
        'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', limit: { context: 272_000 } }
      }
    }
  ],
  default: { openai: 'gpt-5.6-luna' }
}

test('provider list becomes picker rows, led by the default sentinel', () => {
  const rows = mapProviderList(PROVIDERS)
  assert.equal(rows[0].id, OPENCODE_DEFAULT_MODEL)
  assert.ok(rows.every((r) => r.provider === 'opencode'))

  const luna = rows.find((r) => r.id === 'opencode:openai/gpt-5.6-luna')
  assert.ok(luna)
  assert.equal(luna.label, 'GPT-5.6 Luna')
  assert.equal(luna.description, 'OpenAI')
  assert.equal(luna.contextWindow, 272_000)
  // No effort levels: an empty list is how the composer knows to collapse that
  // menu rather than inheriting Claude's.
  assert.equal(luna.supportedEfforts, undefined)
})

test('an empty or unreachable provider list yields no rows at all', () => {
  // Not even the sentinel: a lone "OpenCode (default)" row on a machine with no
  // binary is a dead end in the picker.
  assert.deepEqual(mapProviderList(null), [])
  assert.deepEqual(mapProviderList({}), [])
  assert.deepEqual(mapProviderList({ providers: [] }), [])
})

test('`connected` filters the list when the endpoint sends it', () => {
  const rows = mapProviderList({ ...PROVIDERS, all: PROVIDERS.providers, connected: ['openai'] })
  assert.ok(rows.some((r) => r.id === 'opencode:openai/gpt-5.6-luna'))
  assert.ok(
    !rows.some((r) => r.id.startsWith('opencode:opencode/')),
    'a provider the user has no credentials for must not be offered'
  )
})
