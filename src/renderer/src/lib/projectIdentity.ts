/**
 * A project's fallback mark: two letters and one hue.
 *
 * Most projects have an icon of their own — `main/projects.ts` finds it — and
 * this is what the rest get. It has to be *stable* (the same project draws the
 * same mark forever, across launches and machines) and *distinguishable* (two
 * folders in one list must not land on the same disc), which rules out both a
 * random colour and a colour stored anywhere: a mark you have to persist is a
 * mark that can go missing.
 *
 * Dependency-free on purpose, so `node --test` can run the `.ts` directly —
 * the deal `lib/taskList.ts` and `main/partialJson.ts` already make.
 */

/**
 * Twelve hues, evenly spaced around the wheel.
 *
 * **Spaced, not continuous.** Hashing straight to `h % 360` is one line
 * shorter and routinely puts two projects four degrees apart, which reads as a
 * mistake rather than as two colours — worse than an outright repeat, because
 * a repeat is obviously "two things I have to read the letters on" while a near
 * miss looks like the app failed to tell them apart. Twelve is as many as stay
 * legible from each other at 28px; past that the wheel is fuller than the eye.
 *
 * The values are hues only. Lightness and chroma come from `--project-ink-*`
 * in `index.css` so one hue reads on both grounds — a colour that works on the
 * light sheet is invisible on the dark one, and the alternative (two hard-coded
 * colours per project) would be twenty-four constants to keep in step.
 */
export const PROJECT_HUES = [15, 45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345] as const

/**
 * FNV-1a, 32-bit. A hash rather than a counter because the mark must not depend
 * on how many projects came before it: a counter would repaint every disc the
 * day a project is removed from the middle of the list.
 */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The hue for a project, keyed on its **path**.
 *
 * Deliberately not on the display name: renaming a project in Settings is a
 * label change, and repainting its mark at the same moment would make one
 * gesture look like two. The path is also what the rest of the app keys on.
 */
export function projectHue(root: string): number {
  return PROJECT_HUES[hash(root) % PROJECT_HUES.length]!
}

/**
 * Two letters for a project, from the **display name** — the opposite choice
 * to the hue's, and for the same reason: the letters *are* the name, so a
 * project renamed "Carbon" must stop saying "AG".
 *
 * The letters are the initials of the first two words, where a word is any run
 * git and npm would let you type: `ai-gui` → AG, `my_app` → MA, `carbon` → CA.
 * A camelCase or PascalCase single word is split on the case change
 * (`nextDoor` → ND, `HTTPServer` → HS), since that is the one place a name
 * hides a second word with no separator. Everything else falls back to the
 * first two characters of the only word there is, which is why `carbon` is CA
 * and not C — one letter on a disc reads as a bullet, not a name.
 */
export function projectInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'

  // Strip a leading dot (`.dotfiles`) and anything that is not a letter or a
  // digit becomes a separator — `@scope/pkg`, `ai-gui`, `my_app`, `v2 app`.
  const words = trimmed
    .replace(/^[.@]+/, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)

  if (words.length === 0) return '?'
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()

  const word = words[0]!
  // One word: a case change is a word boundary, and there are three of them —
  // `nextDoor`, `NextDoor`, and the acronym run in `AIGui` / `HTTPServer`,
  // where the boundary is the *last* capital rather than the first. A digit is
  // not a boundary: `app2` is one word, not "AP" + "2".
  const camel =
    /^(\p{Ll}+)(\p{Lu})/u.exec(word) ??
    /^(\p{Lu}\p{Ll}+)(\p{Lu})/u.exec(word) ??
    /^(\p{Lu})\p{Lu}*?(\p{Lu}\p{Ll})/u.exec(word)
  if (camel) return (camel[1]![0]! + camel[2]![0]!).toUpperCase()
  return word.slice(0, 2).toUpperCase()
}

/**
 * The folder name of a path, with no `node:path` to import.
 *
 * Trailing separators are dropped first, so `/a/b/` names `b` rather than
 * nothing — a project root arrives from `chat.cwd`, which is whatever the
 * directory picker handed over.
 */
export function folderName(path: string): string {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || path
}
