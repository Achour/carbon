#!/usr/bin/env node
/**
 * Seed the demo profile Carbon's marketing screenshots are taken against.
 *
 * The app renders whatever is in its own database, so seeded rows go through
 * exactly the same components as real ones — nothing here is a mock-up. What it
 * buys is a sidebar with no client names in it, and a conversation that says the
 * same thing every time the shots are refreshed.
 *
 * Run order matters: launch Carbon once against an empty AIGUI_USERDATA so the
 * app creates the schema (and the kv migration marker), quit it, then run this.
 * Writing while the app is open would fight its per-chat `locks` row.
 *
 *   AIGUI_USERDATA=~/Personal/carbon-demo/userdata npm run dev   # once, then quit
 *   node ~/Personal/carbon-demo/seed.mjs
 *
 * Only the ACTIVE chat's messages are ever rendered, so exactly one chat gets a
 * full transcript; the rest are metadata only — that is all a sidebar row reads.
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Everything is relative to this file, so the profile travels with the repo.
const ROOT = dirname(fileURLToPath(import.meta.url))
const DB = join(ROOT, 'userdata', 'chats.db')
const NIMBUS = join(ROOT, 'projects', 'nimbus')
const PULSE = join(ROOT, 'projects', 'pulse')
const ATLAS = join(ROOT, 'projects', 'atlas')
const PULSE_WT = join(ROOT, 'worktrees', 'pulse-rate-limits')

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = Date.now()

/**
 * Bucket headers only appear for chats older than today, and "Today" is
 * deliberately unlabelled — so the spread here is what makes the detailed
 * sidebar show any structure at all.
 */
const chats = [
  {
    id: 'demo-nimbus-landing',
    title: 'Build the Nimbus landing page',
    provider: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    cwd: NIMBUS,
    updatedAt: now - 4 * MIN,
    hero: true
  },
  {
    id: 'demo-pulse-ratelimit',
    title: 'Rate limit per project key',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    cwd: PULSE_WT,
    worktree: { repoRoot: PULSE, branch: 'rate-limits' },
    updatedAt: now - 38 * MIN,
    pinnedAt: now - 3 * DAY
  },
  {
    id: 'demo-atlas-plan',
    title: 'Add a search index to the docs',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    cwd: ATLAS,
    updatedAt: now - 12 * MIN,
    plan: true
  },
  {
    id: 'demo-pulse-backpressure',
    title: 'Explain the ingest backpressure path',
    provider: 'grok',
    model: 'grok-4.6',
    cwd: PULSE,
    updatedAt: now - 2 * HOUR - 20 * MIN
  },
  {
    id: 'demo-nimbus-sparkline',
    title: 'Sparkline that stretches without thickening',
    provider: 'claude',
    model: 'claude-sonnet-5',
    cwd: NIMBUS,
    updatedAt: now - 26 * HOUR
  },
  {
    id: 'demo-atlas-quickstart',
    title: 'Quickstart copy pass',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    cwd: ATLAS,
    updatedAt: now - 30 * HOUR
  },
  {
    id: 'demo-pulse-rollup',
    title: 'Cache the 7-day rollup query',
    provider: 'grok',
    model: 'grok-4.6',
    cwd: PULSE,
    updatedAt: now - 3 * DAY
  },
  {
    id: 'demo-nimbus-pricing',
    title: 'Dark mode pass on the pricing grid',
    provider: 'claude',
    model: 'claude-sonnet-5',
    cwd: NIMBUS,
    updatedAt: now - 4 * DAY,
    pinnedAt: now - 4 * DAY
  },
  {
    id: 'demo-pulse-retry',
    title: 'Retry policy for the edge collector',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    cwd: PULSE,
    updatedAt: now - 6 * DAY
  },
  {
    id: 'demo-atlas-search',
    title: 'Search across the docs pages',
    provider: 'claude',
    model: 'claude-opus-5',
    cwd: ATLAS,
    updatedAt: now - 8 * DAY
  }
]

/** The one full transcript: what the hero shot shows in the middle column. */
function heroMessages(ts) {
  const t = (offsetMs) => ts + offsetMs
  return [
    {
      id: 'm1',
      role: 'user',
      ts: t(0),
      text: 'Build out the Nimbus landing page — hero, stats strip with the sparkline, and the three pricing tiers. Dark, one accent colour, no gradients.'
    },
    {
      id: 'm2',
      role: 'assistant',
      ts: t(4_000),
      parts: [
        {
          type: 'text',
          text: "I'll read what's already there before I write anything — the tiers and the formatter exist, so the page should use them rather than restate them."
        },
        {
          type: 'tool',
          toolUseId: 't1',
          name: 'Read',
          input: { file_path: `${NIMBUS}/src/pricing.ts` },
          status: 'success',
          output: 'export interface Tier {\n  id: string\n  name: string\n  monthly: number\n  events: number\n  featured?: boolean\n}\n\nexport const TIERS: Tier[] = [...]'
        },
        {
          type: 'tool',
          toolUseId: 't2',
          name: 'Glob',
          input: { pattern: 'src/**/*.{tsx,css}' },
          status: 'success',
          output: 'src/App.tsx\nsrc/Sparkline.tsx\nsrc/main.tsx\nsrc/index.css'
        }
      ]
    },
    {
      id: 'm3',
      role: 'assistant',
      ts: t(38_000),
      parts: [
        {
          type: 'text',
          text: 'Four decisions worth stating, since each one is a place the obvious choice is wrong:\n\n- **Accent is one indigo** (`#6d5cff`), used in exactly three places: the sparkline stroke, the featured tier\'s hairline, and the favicon. Everything else is white-alpha greys — no glows, no gradients, no pill shapes.\n- **Rhythm is `--gap: 48px`, not 96.** Each section contributes half, so adjacent sections sum to the intended ~96px instead of doubling to 192.\n- **The chart is a plain `<svg>`** with `preserveAspectRatio="none"` plus `vector-effect="non-scaling-stroke"`, so it stretches to any card width without thickening the line. `overflow: visible` keeps the end-of-series dot from being clipped in half.\n- **Left-aligned hero rather than centred** — at 840px a centred hero with a 30rem paragraph reads as a template.'
        },
        {
          type: 'tool',
          toolUseId: 't3',
          name: 'Edit',
          input: { file_path: `${NIMBUS}/src/index.css` },
          status: 'success',
          output: 'Applied 1 edit to src/index.css'
        },
        {
          type: 'tool',
          toolUseId: 't4',
          name: 'Edit',
          input: { file_path: `${NIMBUS}/src/App.tsx` },
          status: 'success',
          output: 'Applied 1 edit to src/App.tsx'
        },
        {
          type: 'tool',
          toolUseId: 't5',
          name: 'Bash',
          input: { command: 'npm run build', description: 'Type-check and build' },
          status: 'success',
          output: '> nimbus@0.3.1 build\n> tsc -b && vite build\n\nvite v7.1.3 building for production...\n✓ 34 modules transformed.\ndist/index.html                 0.46 kB │ gzip: 0.30 kB\ndist/assets/index-C7f2a1.css    4.812 kB │ gzip: 1.44 kB\ndist/assets/index-B1d9e4.js   143.207 kB │ gzip: 46.11 kB\n✓ built in 412ms'
        }
      ]
    },
    {
      id: 'm4',
      role: 'assistant',
      ts: t(96_000),
      fileChanges: [
        { path: 'src/index.css', additions: 169, deletions: 2 },
        { path: 'src/App.tsx', additions: 2, deletions: 1 },
        { path: 'public/favicon.svg', additions: 1, deletions: 1 }
      ],
      parts: [
        {
          type: 'text',
          text: 'Build passes. Breakpoints at 780px and 440px handle the way down: the stats and pricing grids go single-column, the nav drops its sign-in link, and the trust row stacks. The preview on the right is the live dev server, so this is the page itself rather than a description of it.'
        }
      ]
    },
    {
      id: 'm5',
      role: 'event',
      kind: 'turn',
      ts: t(97_000),
      text: 'Turn complete',
      stats: {
        costUsd: 0.2841,
        durationMs: 96_400,
        numTurns: 3,
        model: 'claude-opus-5',
        inputTokens: 41_882,
        outputTokens: 3_914
      }
    }
  ]
}

/**
 * A chat parked on a plan awaiting approval. Opening it rebuilds the permission
 * request from `pendingPlanReview` and opens the plan panel — the same path a
 * restart takes, so the shot is the real review surface rather than a mock.
 */
const PLAN_TEXT = `## Search across the docs

**Index at build time, not at query time.** The docs are static Markdown, so the
index is a build artefact — shipping a prebuilt one costs 40 KB and removes the
whole question of a search backend.

### Steps

1. Walk \`docs/**/*.md\` at build and strip frontmatter, code fences and headings
   into one record per section rather than per file — a page-level hit sends the
   reader to the top of a 400-line page and leaves them to scroll.
2. Build a MiniSearch index over \`{ title, section, body }\`, weighting title
   over body, and write it to \`public/search-index.json\`.
3. Load it lazily on first keystroke in the search box, not on page load: nobody
   pays for search until they use it.
4. Fall back to a plain filter over titles when the fetch fails, so a broken CDN
   degrades to something rather than nothing.

### Not doing

Server-side search, an Algolia account, or fuzzy matching on the body — the
corpus is 22 pages, and a typo-tolerant match over that many words returns
noise, not answers.`

function planMessages(ts) {
  return [
    {
      id: 'p1',
      role: 'user',
      ts: ts,
      text: 'Users cannot find anything in the docs. Plan a search feature before you write any of it.'
    },
    {
      id: 'p2',
      role: 'assistant',
      ts: ts + 6_000,
      parts: [
        {
          type: 'tool',
          toolUseId: 'pt1',
          name: 'Glob',
          input: { pattern: 'docs/**/*.md' },
          status: 'success',
          output: 'docs/quickstart.md\ndocs/querying.md'
        },
        {
          type: 'text',
          text: 'Read both pages. Here is what I would build — it is a plan, not an edit, so nothing is written until you approve it.'
        }
      ]
    }
  ]
}

const db = new DatabaseSync(DB)
db.exec('DELETE FROM messages')
db.exec('DELETE FROM chats')
db.exec('DELETE FROM locks')

const insertChat = db.prepare(
  'INSERT INTO chats (id, updated_at, cwd, meta, rev) VALUES (?, ?, ?, ?, 0)'
)
const insertMessage = db.prepare('INSERT INTO messages (chat_id, seq, body) VALUES (?, ?, ?)')

for (const c of chats) {
  const meta = {
    id: c.id,
    title: c.title,
    titleManual: true,
    cwd: c.cwd,
    provider: c.provider,
    model: c.model,
    effort: c.effort,
    permissionMode: c.provider === 'codex' ? 'auto' : 'acceptEdits',
    createdAt: c.updatedAt - 20 * MIN,
    updatedAt: c.updatedAt,
    ...(c.worktree ? { worktree: c.worktree } : {}),
    ...(c.pinnedAt ? { pinnedAt: c.pinnedAt } : {}),
    ...(c.hero ? { contextTokens: 48_204, contextWindow: 1_000_000 } : {}),
    ...(c.plan
      ? {
          permissionMode: 'plan',
          modeBeforePlan: 'auto',
          pendingPlanReview: { requestId: 'demo-plan-req', plan: PLAN_TEXT, userMessageId: 'p1' }
        }
      : {})
  }
  insertChat.run(c.id, c.updatedAt, c.cwd, JSON.stringify(meta))

  const messages = c.hero
    ? heroMessages(c.updatedAt - 97_000)
    : c.plan
      ? planMessages(c.updatedAt - 20_000)
      : null
  if (messages) messages.forEach((m, seq) => insertMessage.run(c.id, seq, JSON.stringify(m)))
}

const counts = db.prepare('SELECT (SELECT count(*) FROM chats) c, (SELECT count(*) FROM messages) m').get()
console.log(`seeded ${counts.c} chats, ${counts.m} messages into ${DB}`)
db.close()
