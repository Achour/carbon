export interface Tier {
  id: string
  name: string
  monthly: number
  events: number
  featured?: boolean
}

export const TIERS: Tier[] = [
  { id: 'hobby', name: 'Hobby', monthly: 0, events: 100_000 },
  { id: 'team', name: 'Team', monthly: 49, events: 10_000_000, featured: true },
  { id: 'scale', name: 'Scale', monthly: 199, events: 100_000_000 }
]

/** Price per million events, used by the comparison table. */
export function perMillion(tier: Tier): number {
  if (tier.monthly === 0) return 0
  return (tier.monthly / tier.events) * 1_000_000
}

export function formatEvents(events: number): string {
  if (events >= 1_000_000) return `${events / 1_000_000}M`
  if (events >= 1_000) return `${events / 1_000}K`
  return String(events)
}
