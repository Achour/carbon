/**
 * What a run of tool calls *did*, in one line of prose.
 *
 * The old answer for a mixed run was "Workspace activity · 7 actions", which
 * names the one thing the reader already knows — that something happened — and
 * nothing they wanted. Cursor's answer is a clause per kind with a count on
 * each ("Edited 1 file, read 3 files, 2 searches"), and it is strictly more
 * informative at the same width, because the counts are what the reader is
 * scanning for.
 *
 * It keys off `toolMeta`'s **label**, not off the tool's name, and that is what
 * makes it provider-neutral for free: Codex and Grok already normalize their
 * calls onto the same canonical names (`codex.ts`, `grokAcp.ts`'s `toolName`),
 * so all three arrive here as the same handful of labels. A `Record` per
 * provider would have been three copies of one sentence.
 *
 * Dependency-free so `node --test` can run `test/toolSummary.test.ts` against
 * the `.ts` directly — no `@shared` import, the constraint `lib/drafts.ts`
 * already lives under.
 */

/**
 * A kind of work, with the two tenses a row needs and the noun it counts.
 *
 * `verb` is allowed to be empty: a search is named by its own noun ("2
 * searches"), and prefixing it with a verb ("searched 2 searches") is the kind
 * of phrasing that only reads as English to the person who wrote the template.
 */
type Activity = {
  /** Ordering key — clauses come out in this order regardless of call order. */
  rank: number
  past: string
  gerund: string
  one: string
  many: string
}

/**
 * The clause order is fixed, and it is not the order the calls happened in.
 * A turn's reads and searches are its *method*; what it changed is its result,
 * so the edits lead. Chronological order would put a run's twelve reads ahead
 * of the one write that mattered on most rows.
 */
const ACTIVITIES: Record<string, Activity> = {
  Edit: { rank: 0, past: 'Edited', gerund: 'Editing', one: 'file', many: 'files' },
  Write: { rank: 1, past: 'Wrote', gerund: 'Writing', one: 'file', many: 'files' },
  Run: { rank: 2, past: 'Ran', gerund: 'Running', one: 'command', many: 'commands' },
  Git: { rank: 2, past: 'Ran', gerund: 'Running', one: 'command', many: 'commands' },
  Terminal: { rank: 2, past: 'Ran', gerund: 'Running', one: 'command', many: 'commands' },
  // Beside Write, and above the reads: a canvas is a *result* of the turn, the
  // same kind of thing a written file is.
  Canvas: { rank: 1, past: 'Wrote', gerund: 'Writing', one: 'canvas', many: 'canvases' },
  // The shell verbs `humanizeShellCommand` names — Codex does its file work
  // through them. Without a clause each fell to the unknown-label fallback,
  // and a run read "read 1 file, create folder ×1": a label wearing a
  // multiplication sign, in a sentence where everything else has a verb.
  'Create folder': { rank: 1, past: 'Created', gerund: 'Creating', one: 'folder', many: 'folders' },
  Copy: { rank: 1, past: 'Copied', gerund: 'Copying', one: 'file', many: 'files' },
  Move: { rank: 1, past: 'Moved', gerund: 'Moving', one: 'file', many: 'files' },
  Remove: { rank: 1, past: 'Removed', gerund: 'Removing', one: 'file', many: 'files' },
  Read: { rank: 3, past: 'Read', gerund: 'Reading', one: 'file', many: 'files' },
  List: { rank: 4, past: 'Listed', gerund: 'Listing', one: 'folder', many: 'folders' },
  // Every way of asking "where is it" counts as one kind. Grep and Glob are one
  // question asked of two indexes, and a `rg` typed into Bash is the same
  // question again — splitting them would print three clauses for one activity.
  Grep: { rank: 5, past: '', gerund: '', one: 'search', many: 'searches' },
  Glob: { rank: 5, past: '', gerund: '', one: 'search', many: 'searches' },
  Search: { rank: 5, past: '', gerund: '', one: 'search', many: 'searches' },
  'Find files': { rank: 5, past: '', gerund: '', one: 'search', many: 'searches' },
  'List files': { rank: 5, past: '', gerund: '', one: 'search', many: 'searches' },
  Fetch: { rank: 6, past: 'Fetched', gerund: 'Fetching', one: 'page', many: 'pages' },
  // Verb-less, because no verb covers the run: a browser sequence is clicks,
  // key presses, screenshots and one navigation, and the honest name for the
  // set of them is what they are. "Browsed 14 pages" would be flatly wrong —
  // fourteen calls are usually one page being worked.
  Browser: { rank: 7, past: '', gerund: '', one: 'browser action', many: 'browser actions' },
  Preview: { rank: 8, past: '', gerund: '', one: 'preview action', many: 'preview actions' },
  'Find tools': { rank: 9, past: 'Found', gerund: 'Finding', one: 'tool', many: 'tools' },
  Agent: { rank: 10, past: '', gerund: '', one: 'agent', many: 'agents' },
  // Last, and verb-less. The checklist is neither the turn's method nor its
  // result — it is the agent keeping its own notes, and the list it wrote is on
  // screen above the composer either way. "Updated 3 tasks" would also read as
  // three tasks *finished*, which is a claim only the dock can make.
  Tasks: { rank: 11, past: '', gerund: '', one: 'task update', many: 'task updates' }
}

/** `3` + `file`/`files`. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * One line naming every kind of work in a run.
 *
 * `running` swings the whole row into the present rather than only its last
 * clause: the run is one unit, and a row reading "Editing 1 file, read 3 files"
 * describes two moments in time that the reader then has to reconcile.
 */
export function summarizeActivity(labels: string[], running = false): string {
  if (labels.length === 0) return running ? 'Working' : 'No activity'

  // Anything with no entry above is counted, but keeps its label so a uniform
  // run of one unknown tool can still name it. Only a *mixed* bag of unknowns
  // has to fall back to the word "steps".
  const known = new Map<string, { activity: Activity; n: number }>()
  const unknown = new Map<string, number>()
  for (const label of labels) {
    const activity = ACTIVITIES[label]
    if (activity) {
      // Keyed on the *words*, so two kinds that share a verb and a noun merge
      // (every shell label is "Ran … commands"; every search is "… searches")
      // and two that share only a rank or a noun stay apart — Copy, Move and
      // Remove all count files at Write's rank, and are three clauses.
      const key = `${activity.past}|${activity.gerund}|${activity.many}`
      const seen = known.get(key)
      if (seen) seen.n += 1
      else known.set(key, { activity, n: 1 })
    } else {
      unknown.set(label, (unknown.get(label) ?? 0) + 1)
    }
  }

  const clauses = [...known.values()]
    .sort((a, b) => a.activity.rank - b.activity.rank)
    .map(({ activity, n }) => {
      const verb = running ? activity.gerund : activity.past
      const noun = count(n, activity.one, activity.many)
      return verb ? `${verb} ${noun}` : noun
    })

  const unknownTotal = [...unknown.values()].reduce((a, b) => a + b, 0)
  if (unknownTotal > 0) {
    // A run of one unnamed tool says which one — "Skill ×2" beats "2 steps",
    // and it is the only name that tool has anywhere on the collapsed row.
    clauses.push(
      unknown.size === 1
        ? `${[...unknown.keys()][0]} ×${unknownTotal}`
        : count(unknownTotal, 'step', 'steps')
    )
  }

  // Only the first clause is capitalized: the row is one sentence, and a
  // capital on each would read as a list of headings.
  return clauses
    .map((clause, i) => (i === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1)))
    .join(', ')
}
