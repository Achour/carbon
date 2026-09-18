import * as React from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { folderName } from '@/lib/projectIdentity'
import { projectLabel } from '@/lib/projects'
import { useApp, visibleChats } from '@/store'
import { projectRoot } from '@shared/types'

/**
 * What can be asked of a project, other than opening it.
 *
 * Four questions, one dialog host. They were written inside `Sidebar.tsx`,
 * driven by four pieces of its local state, which was fine while the sidebar
 * was the only place a project could be acted on. Settings → Projects is the
 * second, and a second copy of "Remove project?" is how two confirmations
 * end up saying different things about what gets deleted.
 */
export type ProjectAction = 'rename' | 'archive' | 'hide' | 'remove'

export interface ProjectPrompt {
  kind: ProjectAction
  cwd: string
}

/**
 * The project dialogs, hosted wherever a project list is drawn.
 *
 * Everything but the prompt itself comes from the store — the name map, the
 * flags, the chat count — so the two hosts cannot disagree about how many chats
 * a Remove would take with it. `onClose` is the only thing a host owns, because
 * the prompt is the host's state: the sidebar opens these from a context menu
 * and Settings from a row's overflow, and neither should be able to see the
 * other's open dialog.
 */
export function ProjectDialogs({
  prompt,
  onClose
}: {
  prompt: ProjectPrompt | null
  onClose: () => void
}): React.JSX.Element {
  const chats = useApp((s) => s.chats)
  const projectNames = useApp((s) => s.projectNames)
  const setProjectName = useApp((s) => s.setProjectName)
  const setProjectHidden = useApp((s) => s.setProjectHidden)
  const setProjectArchived = useApp((s) => s.setProjectArchived)
  const removeProject = useApp((s) => s.removeProject)
  // The archive copy names the way back, and the way back differs by density:
  // compact keeps an Archived section on screen, detailed drops the project out
  // of the flat list entirely.
  const detailed = useApp((s) => s.sidebarDensity) === 'detailed'

  const cwd = prompt?.cwd ?? ''
  const label = cwd ? projectLabel(cwd, projectNames) : ''
  const count = React.useMemo(
    () => (cwd ? visibleChats(chats).filter((c) => projectRoot(c) === cwd).length : 0),
    [chats, cwd]
  )
  const chatsPhrase = count === 1 ? 'chat' : `${count} chats`

  // Seeded when the rename dialog opens, so reopening it never shows the
  // previous project's name for a frame.
  const [name, setName] = React.useState('')
  React.useEffect(() => {
    if (prompt?.kind === 'rename') setName(projectLabel(prompt.cwd, projectNames))
    // `projectNames` deliberately absent: this seeds on open, and re-seeding on
    // every keystroke's write would fight the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt])

  return (
    <>
      {/* Rename */}
      <Dialog open={prompt?.kind === 'rename'} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            A display name for this project in the sidebar. Leave blank to use the folder name. The
            folder on disk is not renamed.
          </DialogDescription>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!cwd) return
              // An empty value (or one equal to the folder name) clears the override.
              setProjectName(cwd, name.trim() === folderName(cwd) ? '' : name)
              onClose()
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder={cwd ? folderName(cwd) : 'Project name'}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Archive / hide. Deliberately NOT a destructive button: red is this
          app's mark for data loss, and neither of these loses any — saying so
          is what keeps the red on Remove meaningful. */}
      <Dialog
        open={prompt?.kind === 'archive' || prompt?.kind === 'hide'}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent>
          <DialogTitle>
            {prompt?.kind === 'hide' ? 'Hide' : 'Archive'} “{label}”?
          </DialogTitle>
          <DialogDescription>
            The project and its {chatsPhrase}{' '}
            {prompt?.kind === 'hide' ? (
              <>
                leave the sidebar. Nothing is deleted — the project comes back when you open the
                folder again.
              </>
            ) : detailed ? (
              <>
                leave the sidebar. Nothing is deleted — filter to the project to find it again and
                unarchive it.
              </>
            ) : (
              <>move to the Archived section at the bottom of the sidebar. Nothing is deleted.</>
            )}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (prompt?.kind === 'hide') setProjectHidden(cwd, true)
                else if (prompt) setProjectArchived(cwd, true)
                onClose()
              }}
            >
              {prompt?.kind === 'hide' ? 'Hide project' : 'Archive project'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove */}
      <Dialog open={prompt?.kind === 'remove'} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogTitle>Remove “{label}”?</DialogTitle>
          <DialogDescription>
            The project is removed from the sidebar and its{' '}
            {count === 1 ? 'chat is' : `${count} chats are`} deleted permanently. Files on disk are
            not touched.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (cwd) void removeProject(cwd)
                onClose()
              }}
            >
              Remove project
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
