# Usage

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### Usage (`src/main/usageScan.ts`, `usageStats.ts`, `components/UsageStats.tsx`)

Two different questions wear the word "usage", and they share nothing. `usage.ts`
+ `UsagePanel` ask the providers **how much plan headroom is left right now** —
answered live, off a throwaway process, shown as a chip in the sidebar footer.
`usageStats.ts` + the Usage **page** ask **what was spent, on what, over the last
7/30/90 days** — a history question no live API answers, since no provider bills a
subscription per token. Only Claude and Codex answer the *live* question at all;
Grok exposes no plan-headroom endpoint, so it appears on the page and never in the
sidebar chip.

The only durable record is the CLIs' own session logs, so that is the source:
`~/.claude/projects/<slug>/<session>.jsonl`,
`~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, and
`~/.grok/sessions/<percent-encoded cwd>/<id>/updates.jsonl`. Reading them covers
Carbon's own turns *for free* — every adapter drives the real CLI, so an in-app
chat lands in the same files as a terminal one. That is also why the page does **not** also sum the
`TurnStats` on our own event messages: it would double every in-app turn.

- **Subagents are separate files.** A Task/subagent turn is written to
  `<session>/subagents/agent-*.jsonl` (and one level deeper under
  `subagents/workflows/<id>/`), sharing no message ids with the parent and leaving
  no `isSidechain` copy in it. Stopping the directory walk at the session file
  silently omitted ~16% of spend, which is why `collectJsonl` descends 6 levels.
- **Dedupe is per file, on `message.id` + `requestId`.** One API response is
  written once per content block, so a turn with text *and* a tool call appears
  twice carrying identical usage.
- **A fork is the one thing that crosses files, and `forkedFrom` is what names
  it.** Rewinding or branching a session writes a *new* transcript with the
  shared history replayed into it, and the replay is not recognizable as a copy:
  `sessionId`, `uuid` and `parentUuid` are all rewritten to the new session, so
  the two files agree on nothing but the dedupe key — which is per-file state,
  and a per-file cache cannot hold it. `forkedFrom` (`{sessionId, messageUuid}`)
  rides exactly the replayed lines and is null on the originals, so the reader
  skips them and each response is counted in the transcript that spent it.
  Measured over a 30-day corpus: 631 replayed lines, every one with an unforked
  twin still on disk, $189 of double-counted spend on a $7.3k reading. Deleting
  a parent transcript strands its forks' prefix — the better half of a trade
  whose other side bills that prefix twice for everyone who ever rewound.
- **Codex reports a running total and a per-call delta** on `token_count` events,
  and no model — hence `CodexFileReader`, a per-file cursor that carries the model
  forward from `turn_context` / `thread_settings_applied` and sums only the delta.
  Its `input_tokens` is *inclusive* of `cached_input_tokens`; Claude's is not.
- **Grok reports the cost itself**, on one line kind: an `_x.ai/session/update`
  whose `sessionUpdate` is `turn_completed`, carrying per-model totals and
  `costUsdTicks` at 1e-10 USD per tick. Its totals are *per turn* (verified
  against a session whose three turns rise then fall), so they sum rather than
  needing Codex's delta treatment, and `inputTokens` is inclusive like Codex's.
  This is the one case where a cell stores money: the rule against it exists
  because a *computed* estimate would freeze one day's rate table into a file
  that is never re-read, and a provider-reported figure has no such defect — it
  is not an estimate of what a turn cost, it is what the turn cost. `priceCell`
  prefers it. The derived `grok` rate entry therefore never prices a turn; it
  exists only for the cache-savings counterfactual, which has no reported
  equivalent and read as a flat $0 without it.
- **Rates are fetched, not hard-coded** (`usageRates.ts`). A static table cannot
  price the Codex-only slugs: `gpt-5.6-sol` bills at $5/$30 per MTok, 4× the
  GPT-5 family it is named after, and guessing the family understated Codex spend
  by ~4×. They come from LiteLLM's public `model_prices_and_context_window.json`
  — the feed `ccusage` prices against — cached 24h in `userData/usage-rates.json`,
  fetched only when the page is opened. The built-in table in `usageScan.ts` is
  the fallback, not the source: it answers before the first fetch and forever if
  the fetch never lands, and an id the feed doesn't know falls through to it and
  then to being reported unpriced rather than silently free.
- **The 1-hour cache-write rate is applied** (2× input vs 1.25× for 5-minute).
  Claude Code writes 1-hour caches almost exclusively and they run to ~170M
  tokens a month, so collapsing the two TTLs understates Claude by ~8%. Fast mode
  is likewise a different SKU rather than a faster tier — `usage.speed` says which
  served the turn, and it is part of the cell key for exactly that reason.
- **Nothing is read twice, and cells hold tokens rather than money.** Each file
  reduces to a few `(model, speed, day)` cells cached under `(path, mtime, size)`
  in `userData/usage-cache.json`; session logs are append-only, so an unchanged
  stamp means unchanged content. Cost is applied at *read* time (`priceCell`) —
  a cell that stored dollars would freeze one day's rates into a file that never
  changes again and therefore never gets re-read, which is precisely the bug a
  refreshing rate feed would otherwise introduce. A cold scan is ~2 GB and ~5 s,
  a warm one ~20 ms, and switching range never re-reads. `CACHE_VERSION` now
  tracks only the *parsing* — rate changes reprice for free.

`--chart-claude` / `--chart-codex` / `--chart-grok` (`index.css`) are the one place
the app carries hue a theme does not set: on a page whose job is comparing
providers the colors *are* the labels, so they must not move when the theme does.
Validated for CVD separation and contrast in both modes — they are not
interchangeable with `--warning` / `--success`, which mean state rather than
identity.

The third series is a materially harder problem than the first two, and the
numbers say so. Warm/cool alone carries a *pair* through every CVD type with room
to spare (ΔE00 ≥ 44); a third hue has to clear both at once, and the obvious pick
— a green — collapses against orange under protan/deutan (ΔE00 12) and against
blue under tritan (ΔE00 5). Plum at low lightness is the best any single hue
family manages, because it separates on *lightness*, which CVD preserves, rather
than on hue alone: light clears 20 on every pair, dark's tightest is 18.1. That
shortfall is stated rather than designed away — the alternative was a near-gray at
chroma 0.04, which buys ΔE00 21.6 by giving up being a color at all. Re-run the
check before touching any of the three, since they are now solved as a set.

`--brand-grok` is a different decision: xAI's mark is monochrome like OpenAI's, so
it takes the *same* value as `--brand-codex` rather than a hue invented to
separate them. The shapes carry the difference — OpenAI's knot against xAI's two
slashes is a wider gap at 14px than any two hues would be — and a tinted xAI badge
would be a brand fact we made up, which is exactly the error the blue-Codex note
above rules out.
