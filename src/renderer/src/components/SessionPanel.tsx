import * as React from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CircleUser,
  Loader2,
  Power,
  RefreshCw,
  Server,
  Shield,
  Trash2
} from 'lucide-react'
import type {
  AccountInfo,
  AgentInfo,
  McpServerInfo,
  PermissionRule,
  UsageInfo
} from '@shared/types'
import { cn } from '@/lib/utils'
import { formatCost } from '@/lib/format'
import { useApp } from '@/store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WithTooltip } from '@/components/ui/tooltip'

/** Compact "time until reset" for a future epoch-ms timestamp. */
function resetsIn(ts: number): string {
  const diff = ts - Date.now()
  if (!Number.isFinite(diff) || diff <= 0) return 'soon'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${Math.max(1, min)}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const STATUS_COLOR: Record<McpServerInfo['status'], string> = {
  connected: 'bg-emerald-500',
  failed: 'bg-destructive',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-muted-foreground',
  disabled: 'bg-muted-foreground/40'
}

function SectionTitle({
  icon: Icon,
  children,
  action
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {children}
      </span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}

/** A 0–100 utilization bar with a label and reset time. */
function UsageBar({
  label,
  utilization,
  resetsAt
}: {
  label: string
  utilization: number | null
  resetsAt?: string | null
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, utilization ?? 0))
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {utilization == null ? '—' : `${Math.round(pct)}%`}
          {Number.isFinite(reset) && <span className="ml-1 opacity-70">· resets in {resetsIn(reset)}</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full',
            pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-amber-500' : 'bg-primary'
          )}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Session introspection: account & usage/limits, MCP servers, subagents, and
 * persisted permission rules for the active chat's session. Data loads lazily
 * when the popover opens (this may start the chat's CLI session if idle).
 */
export function SessionPanel(): React.JSX.Element {
  const chatId = useApp((s) => s.activeId)
  const cwd = useApp((s) => s.selectedCwd)
  const rateLimit = useApp((s) => (s.activeId ? s.rateLimits[s.activeId] : undefined))
  const loadModels = useApp((s) => s.loadModels)

  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [live, setLive] = React.useState<boolean | null>(null)
  const [account, setAccount] = React.useState<AccountInfo | null>(null)
  const [usage, setUsage] = React.useState<UsageInfo | null>(null)
  const [servers, setServers] = React.useState<McpServerInfo[] | null>(null)
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null)
  const [rules, setRules] = React.useState<PermissionRule[] | null>(null)

  const refreshMcp = React.useCallback(async () => {
    if (!chatId) return
    setServers(await window.api.mcpStatus(chatId))
  }, [chatId])

  const refreshRules = React.useCallback(async () => {
    if (!cwd) return
    setRules(await window.api.getPermissionRules(cwd))
  }, [cwd])

  const load = React.useCallback(async () => {
    if (!chatId) return
    setBusy(true)
    // Permission rules are read from settings files and don't need a session.
    await refreshRules()
    const isLive = await window.api.sessionLive(chatId)
    setLive(isLive)
    if (!isLive) {
      setBusy(false)
      return
    }
    void loadModels()
    const [acc, use, srv, agt] = await Promise.all([
      window.api.accountInfo(chatId),
      window.api.usageInfo(chatId),
      window.api.mcpStatus(chatId),
      window.api.listAgents(chatId)
    ])
    setAccount(acc)
    setUsage(use)
    setServers(srv)
    setAgents(agt)
    setBusy(false)
  }, [chatId, loadModels, refreshRules])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const toggleServer = async (s: McpServerInfo): Promise<void> => {
    if (!chatId) return
    await window.api.mcpToggle(chatId, s.name, s.status === 'disabled')
    await refreshMcp()
  }
  const reconnect = async (name: string): Promise<void> => {
    if (!chatId) return
    await window.api.mcpReconnect(chatId, name)
    await refreshMcp()
  }
  const removeRule = async (rule: PermissionRule): Promise<void> => {
    if (!cwd) return
    await window.api.removePermissionRule(cwd, rule)
    await refreshRules()
  }

  if (!chatId) return <></>

  // A warning worth surfacing on the trigger itself.
  const alerting = rateLimit && rateLimit.status !== 'allowed'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label="Session info">
        <PopoverTrigger
          aria-label="Session info"
          className={cn(
            'no-drag flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent data-[popup-open]:bg-accent',
            alerting ? 'text-amber-500' : 'text-muted-foreground'
          )}
        >
          {alerting ? <AlertTriangle className="size-3.5" /> : <Activity className="size-3.5" />}
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent side="top" align="end" className="max-h-[75vh] w-80 overflow-y-auto p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">Session</span>
          <WithTooltip label="Refresh">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            </Button>
          </WithTooltip>
        </div>

        <div className="space-y-4 p-3">
          {live === false && (
            <div className="rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              The session isn’t running. Send a message to view live account, usage, MCP servers
              and subagents. Saved permission rules are shown below.
            </div>
          )}
          {/* Account & usage */}
          {live !== false && (
          <>
          <section>
            <SectionTitle icon={CircleUser}>Account &amp; usage</SectionTitle>
            {account?.email && (
              <div className="text-xs text-foreground">{account.email}</div>
            )}
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {[account?.organization, account?.subscriptionType || usage?.subscriptionType]
                .filter(Boolean)
                .join(' · ') || 'Signed in via Claude Code'}
            </div>
            {usage && (
              <div className="mt-2 flex items-center justify-between rounded-md bg-secondary/40 px-2 py-1.5 text-[11px] tabular-nums text-muted-foreground">
                <span>Session cost {formatCost(usage.costUsd)}</span>
                <span className="text-emerald-500">+{usage.linesAdded}</span>
                <span className="text-destructive">−{usage.linesRemoved}</span>
              </div>
            )}
            {rateLimit && rateLimit.status !== 'allowed' && (
              <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>
                  {rateLimit.status === 'rejected' ? 'Plan limit reached' : 'Approaching plan limit'}
                  {rateLimit.resetsAt ? ` · resets in ${resetsIn(rateLimit.resetsAt)}` : ''}
                </span>
              </div>
            )}
            {usage?.rateLimitsAvailable && usage.windows.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {usage.windows.map((w) => (
                  <UsageBar key={w.label} label={w.label} utilization={w.utilization} resetsAt={w.resetsAt} />
                ))}
              </div>
            )}
            {usage && !usage.rateLimitsAvailable && (
              <div className="mt-1.5 text-[11px] text-muted-foreground/70">
                Plan rate limits don’t apply to this session.
              </div>
            )}
          </section>

          {/* MCP servers */}
          <section className="border-t border-border pt-3">
            <SectionTitle icon={Server}>MCP servers</SectionTitle>
            {servers == null ? (
              <div className="text-[11px] text-muted-foreground">Loading…</div>
            ) : servers.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No MCP servers configured.</div>
            ) : (
              <div className="space-y-1.5">
                {servers.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                  >
                    <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_COLOR[s.status])} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{s.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {s.status}
                        {s.scope ? ` · ${s.scope}` : ''}
                        {s.tools?.length ? ` · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : ''}
                        {s.error ? ` · ${s.error}` : ''}
                      </div>
                    </div>
                    {(s.status === 'failed' || s.status === 'needs-auth') && (
                      <WithTooltip label="Reconnect">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Reconnect ${s.name}`}
                          onClick={() => void reconnect(s.name)}
                        >
                          <RefreshCw className="size-3" />
                        </Button>
                      </WithTooltip>
                    )}
                    <WithTooltip label={s.status === 'disabled' ? 'Enable' : 'Disable'}>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`${s.status === 'disabled' ? 'Enable' : 'Disable'} ${s.name}`}
                        className={s.status === 'disabled' ? 'text-muted-foreground/50' : 'text-foreground'}
                        onClick={() => void toggleServer(s)}
                      >
                        <Power className="size-3" />
                      </Button>
                    </WithTooltip>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Subagents */}
          <section className="border-t border-border pt-3">
            <SectionTitle icon={Bot}>Subagents</SectionTitle>
            {agents == null ? (
              <div className="text-[11px] text-muted-foreground">Loading…</div>
            ) : agents.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No subagents available.</div>
            ) : (
              <div className="space-y-1">
                {agents.map((a) => (
                  <div key={a.name} className="rounded-md px-1.5 py-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs font-medium">{a.name}</span>
                      {a.model && <span className="text-[10px] text-muted-foreground">{a.model}</span>}
                    </div>
                    <div className="line-clamp-2 text-[11px] text-muted-foreground">{a.description}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          </>
          )}

          {/* Permission rules (read from settings files — no session needed) */}
          <section className={cn(live !== false && 'border-t border-border pt-3')}>
            <SectionTitle icon={Shield}>Permission rules</SectionTitle>
            {rules == null ? (
              <div className="text-[11px] text-muted-foreground">Loading…</div>
            ) : rules.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                No saved rules. “Always allow” on a prompt saves one here.
              </div>
            ) : (
              <div className="space-y-1">
                {rules.map((r, i) => (
                  <div
                    key={`${r.source}:${r.behavior}:${r.value}:${i}`}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase',
                        r.behavior === 'allow'
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : r.behavior === 'deny'
                            ? 'bg-destructive/15 text-destructive'
                            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      )}
                    >
                      {r.behavior}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={r.value}>
                      {r.value}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60">{r.source}</span>
                    {r.source !== 'user' && (
                      <WithTooltip label="Remove rule">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove rule ${r.value}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => void removeRule(r)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </WithTooltip>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  )
}
