import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFreeModel,
  mapProviderList,
  opencodeModelId,
  parseOpencodeModelId,
  variantEfforts
} from '../src/main/opencodeModels.ts'
import {
  OPENCODE_DEFAULT_MODEL,
  effortForProvider,
  providerForModel
} from '../src/shared/types.ts'

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

test('free models are marked from the id suffix, never from reported cost', () => {
  const rows = mapProviderList({
    providers: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        models: {
          // Every model the server lists reports cost 0 on a subscription —
          // paid ones included — so cost cannot be the signal.
          'deepseek-v4-flash-free': {
            id: 'deepseek-v4-flash-free',
            name: 'DeepSeek V4 Flash Free',
            cost: { input: 0, output: 0 }
          },
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 } }
        }
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', cost: { input: 0, output: 0 } } }
      }
    ]
  })
  const free = rows.find((r) => r.id === 'opencode:opencode/deepseek-v4-flash-free')
  assert.equal(free?.free, true)
  // The name already ends in "Free"; the badge carries it, so the label doesn't
  // repeat it.
  assert.equal(free?.label, 'DeepSeek V4 Flash')

  // A paid model reporting cost 0 must never be badged free.
  assert.equal(rows.find((r) => r.id === 'opencode:openai/gpt-5.6-sol')?.free, undefined)
  // And a free model without the suffix simply goes unbadged — under-claiming
  // is the safe direction.
  assert.equal(rows.find((r) => r.id === 'opencode:opencode/big-pickle')?.free, undefined)
})

test('isFreeModel only matches the -free suffix', () => {
  assert.equal(isFreeModel('deepseek-v4-flash-free'), true)
  assert.equal(isFreeModel('ling-3.0-tiny-free'), true)
  assert.equal(isFreeModel('free-willy'), false, 'a leading "free" is part of a name')
  assert.equal(isFreeModel('gpt-5.6-sol'), false)
})

test('a model’s variants become its supported efforts', () => {
  const rows = mapProviderList({
    providers: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        models: {
          'deepseek-v4-flash-free': {
            id: 'deepseek-v4-flash-free',
            name: 'DeepSeek V4 Flash Free',
            // Exactly what the live server reports for this model.
            variants: { low: { reasoningEffort: 'low' }, high: {}, max: {} }
          },
          'plain-model': { id: 'plain-model', name: 'Plain' }
        }
      }
    ]
  })
  const deepseek = rows.find((r) => r.id === 'opencode:opencode/deepseek-v4-flash-free')
  assert.deepEqual(deepseek?.supportedEfforts, ['low', 'high', 'max'])
  // A model with no variants advertises none, and the composer then shows the
  // Default row alone — the same path Codex takes.
  assert.equal(rows.find((r) => r.id === 'opencode:opencode/plain-model')?.supportedEfforts, undefined)
})

test('variant names are ordered by the picker, not by the server', () => {
  // The menu reads minimal → max whatever order the object arrived in.
  assert.deepEqual(variantEfforts({ max: {}, low: {}, xhigh: {}, medium: {} }), [
    'low',
    'medium',
    'xhigh',
    'max'
  ])
  assert.deepEqual(variantEfforts(undefined), [])
  assert.deepEqual(variantEfforts({}), [])
})

test('variants with no Carbon equivalent are dropped rather than mistranslated', () => {
  // 'none' (reason as little as possible), 'thinking' and 'default' have no
  // EffortId. Sending 'high' where the user asked for 'none' would be worse
  // than not offering the level at all.
  assert.deepEqual(variantEfforts({ none: {}, thinking: {}, default: {} }), [])
  assert.deepEqual(variantEfforts({ none: {}, high: {} }), ['high'])
})

test('effort survives a switch into OpenCode, except Claude-only ultra', () => {
  // Which levels a given OpenCode model accepts is a per-model question its
  // supportedEfforts answers; the only provider-wide rule is that 'ultra' is
  // Claude's alone.
  assert.equal(effortForProvider('high', 'opencode'), 'high')
  assert.equal(effortForProvider('minimal', 'opencode'), 'minimal')
  assert.equal(effortForProvider('ultra', 'opencode'), undefined)
  assert.equal(effortForProvider(undefined, 'opencode'), undefined)
})
