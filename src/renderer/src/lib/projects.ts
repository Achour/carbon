/**
 * What a project *is*, to the two places that list them.
 *
 * The sidebar has always derived its projects by grouping `chats` on
 * `projectRoot` and then ordering the groups by a saved array. Settings →
 * Projects has to arrive at the same list or the two disagree about what a
 * project is — and they would disagree quietly, one showing a folder the other
 * had dropped. So the derivation is written once, here, and both read it.
 *
 * **A project is a folder some chat lives in, and nothing else is one.** Not a
 * key left behind in `projectNames`, `hiddenProjects` or `archivedProjects` —
 * those maps are annotations on projects, and they outlive the project they
 * annotate (deleting one deliberately leaves its name behind, so re-adding the
 * folder finds it again). Not `recentDirs` either: that is where the *picker*
 * has been, which includes folders no chat was ever started in.
 *
 * Pure and dependency-free of the store, so both the store and the components
 * can import it without a cycle.
 */

import { projectRoot, type ChatMeta } from '@shared/types'
import { folderName } from './projectIdentity'

export interface ProjectGroup {
  cwd: string
  /** Every chat in the project, pinned ones included. */
  chats: ChatMeta[]
}

/**
 * Projects in the user's saved order, with anything unsaved keeping the order
 * it was discovered in — which is `chats` order, i.e. most recently used first,
 * so a folder the app has just met appears at the bottom rather than at a
 * random point in a list the user arranged.
 */
export function projectGroups(chats: ChatMeta[], order: string[]): ProjectGroup[] {
  const groups: ProjectGroup[] = []
  for (const chat of chats) {
    const key = projectRoot(chat)
    const group = groups.find((g) => g.cwd === key)
    if (group) group.chats.push(chat)
    else groups.push({ cwd: key, chats: [chat] })
  }
  const rank = (cwd: string): number => {
    const i = order.indexOf(cwd)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return groups.sort((a, b) => rank(a.cwd) - rank(b.cwd))
}

/** Every project root, ordered — what `projectsOverview` is asked about. */
export function projectRoots(chats: ChatMeta[], order: string[]): string[] {
  return projectGroups(chats, order).map((g) => g.cwd)
}

/**
 * A project's display name: the user's override, else the folder name.
 *
 * One definition because it is drawn in six places and typed into one — the
 * rename dialog seeds its input with this, and an input that disagreed with the
 * label it is editing would make clearing the field look like a bug.
 */
export function projectLabel(cwd: string, names: Record<string, string>): string {
  return names[cwd]?.trim() || folderName(cwd)
}
