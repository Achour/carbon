import * as React from 'react'
import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CompactSelectOption {
  value: string
  label: string
  description?: string
  /** Options sharing a group render under a shared label (e.g. provider name). */
  group?: string
  disabled?: boolean
}

function Item({ option }: { option: CompactSelectOption }): React.JSX.Element {
  return (
    <Select.Item
      value={option.value}
      disabled={option.disabled}
      className="grid cursor-default select-none grid-cols-[1rem_1fr] items-center gap-1.5 rounded-md py-1.5 pr-3 pl-1.5 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent"
    >
      <Select.ItemIndicator className="col-start-1">
        <Check className="size-3.5" />
      </Select.ItemIndicator>
      <div className="col-start-2">
        <Select.ItemText>{option.label}</Select.ItemText>
        {option.description && (
          <div className="text-xs text-muted-foreground">{option.description}</div>
        )}
      </div>
    </Select.Item>
  )
}

/**
 * A small chip-style select used in the composer footer (model, permission mode).
 * Options may carry a `group` label to render provider-style sections.
 */
export function CompactSelect({
  value,
  onValueChange,
  options,
  icon,
  side = 'top',
  className,
  disabled
}: {
  value: string
  onValueChange: (value: string) => void
  options: CompactSelectOption[]
  icon?: React.ReactNode
  side?: 'top' | 'bottom'
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  const selected = options.find((o) => o.value === value)

  const groups: { label: string | undefined; options: CompactSelectOption[] }[] = []
  for (const option of options) {
    const last = groups[groups.length - 1]
    if (last && last.label === option.group) last.options.push(option)
    else groups.push({ label: option.group, options: [option] })
  }
  const hasGroups = groups.some((g) => g.label)

  return (
    <Select.Root
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value}
      onValueChange={(v) => onValueChange(v as string)}
      disabled={disabled}
    >
      <Select.Trigger
        className={cn(
          'no-drag inline-flex h-7 select-none items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground disabled:opacity-50 [&>svg]:shrink-0',
          className
        )}
      >
        {icon}
        <span className="max-w-36 truncate">{selected?.label ?? value}</span>
        <Select.Icon className="shrink-0">
          <ChevronDown className="size-3 opacity-60" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
          alignItemWithTrigger={false}
        >
          <Select.Popup className="min-w-52 max-h-[var(--available-height)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 shadow-xl outline-none transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            {hasGroups
              ? groups.map((group, gi) => (
                  <Select.Group key={group.label ?? gi}>
                    {group.label && (
                      <Select.GroupLabel className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
                        {group.label}
                      </Select.GroupLabel>
                    )}
                    {group.options.map((option) => (
                      <Item key={option.value} option={option} />
                    ))}
                  </Select.Group>
                ))
              : options.map((option) => <Item key={option.value} option={option} />)}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
