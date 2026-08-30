import { TIERS, formatEvents } from './pricing'
import { Sparkline } from './Sparkline'

const STATS = [
  { label: 'Requests served', value: '18.42M' },
  { label: 'p99 query', value: '38ms' },
  { label: 'Regions', value: '31' }
]

export default function App(): JSX.Element {
  return (
    <main className="page">
      <header className="nav">
        <span className="brand">Nimbus</span>
        <a className="ghost" href="/login">
          Sign in
        </a>
      </header>

      <section className="hero">
        <span className="eyebrow">Edge analytics</span>
        <h1>Answers where your traffic already is.</h1>
        <p>
          Nimbus collects events at the edge and answers queries against them in under 50
          milliseconds. No warehouse, no nightly batch, no sampling.
        </p>
        <div className="actions">
          <a className="primary" href="/signup">
            Start building
          </a>
          <a className="secondary" href="/docs">
            Read the docs
          </a>
        </div>
        <ul className="trust">
          <li>4,000 teams</li>
          <li>SOC 2 Type II</li>
          <li>Self-serve, no sales call</li>
        </ul>
      </section>

      <section className="stats">
        {STATS.map((s) => (
          <div className="stat" key={s.label}>
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
          </div>
        ))}
        <Sparkline />
      </section>

      <section className="pricing">
        {TIERS.map((tier) => (
          <article className={tier.featured ? 'tier featured' : 'tier'} key={tier.id}>
            <h3>{tier.name}</h3>
            <p className="price">${tier.monthly}</p>
            <p className="events">{formatEvents(tier.events)} events / mo</p>
          </article>
        ))}
      </section>
    </main>
  )
}
