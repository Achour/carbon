import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ui error]', error.message, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      // `h-full` for the root boundary, whose parent is `#root` rather than a
      // stretched flex row; `flex-1` still does the work inside the content pane.
      <div className="flex h-full flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <AlertTriangle className="mx-auto mb-3 size-8 text-destructive" />
          <div className="mb-1 text-sm font-semibold">Something broke in this view</div>
          <div className="mb-4 select-text text-xs text-muted-foreground">
            {this.state.error.message}
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            {/* Re-rendering the same state is what just threw, so the retry can
                fail on the spot when the cause is persisted (a saved sidebar
                filter, a stored tab). A reload is the escape from that. */}
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
