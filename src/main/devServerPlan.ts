import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * What to run for a project's dev server, read off its files. Dependency-free
 * on purpose — `node --test` runs it straight off the `.ts`.
 */

const SCRIPT_PREFERENCE = ['dev', 'start', 'develop', 'serve', 'preview']

/**
 * Dependencies that mark a workspace package as something a browser shows —
 * the way to choose the app out of a monorepo's `packages/*` without running
 * every package's `dev`.
 */
const WEB_DEPS = [
  'vite', 'next', 'nuxt', 'astro', '@sveltejs/kit', '@remix-run/dev', 'react-scripts', 'gatsby',
  '@angular/core', 'webpack-dev-server', 'parcel', '@tanstack/react-start', 'solid-start', 'expo', 'vue', 'svelte'
]

/** Picks the package manager from lockfiles, defaulting to npm. */
function detectRunner(cwd: string): (script: string) => string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return (s) => `pnpm ${s}`
  if (existsSync(join(cwd, 'yarn.lock'))) return (s) => `yarn ${s}`
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return (s) => `bun run ${s}`
  return (s) => `npm run ${s}`
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

function devScript(pkg: Record<string, any> | null): string | undefined {
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>
  return SCRIPT_PREFERENCE.find((s) => scripts[s])
}

/** What to run, and where: a monorepo's app lives below the project root. */
export interface DevPlan {
  command: string
  dir: string
}

/**
 * The dev command for a project. In order: the root `package.json`; a single
 * web app among the workspace's packages (the lockfile, and so the runner,
 * stays the root's); then the frameworks that are not Node at all.
 */
export function detectDevPlan(cwd: string): DevPlan | null {
  const rootScript = devScript(readJson(join(cwd, 'package.json')))
  if (rootScript) return { command: detectRunner(cwd)(rootScript), dir: cwd }

  const dirs: string[] = []
  for (const base of ['apps', 'packages', 'examples']) {
    try {
      for (const d of readdirSync(join(cwd, base), { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(join(cwd, base, d.name))
      }
    } catch {
      // no such folder
    }
  }
  for (const name of ['web', 'frontend', 'client', 'site', 'www', 'app']) dirs.push(join(cwd, name))
  const apps = dirs
    .map((dir) => ({ dir, pkg: readJson(join(dir, 'package.json')) }))
    .filter(({ pkg }) => {
      if (!pkg || !devScript(pkg)) return false
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      return WEB_DEPS.some((d) => d in deps)
    })
  const pick =
    apps.length === 1
      ? apps[0]
      : apps.find(({ dir }) => /\/(web|app|frontend|site|www)$/.test(dir))
  if (pick) return { command: detectRunner(cwd)(devScript(pick.pkg)!), dir: pick.dir }

  if (existsSync(join(cwd, 'bin/rails'))) return { command: 'bin/rails server', dir: cwd }
  if (existsSync(join(cwd, 'manage.py'))) return { command: 'python3 manage.py runserver', dir: cwd }
  try {
    if (/:phoenix\b/.test(readFileSync(join(cwd, 'mix.exs'), 'utf8'))) return { command: 'mix phx.server', dir: cwd }
  } catch {
    // not Elixir
  }
  try {
    if (existsSync(join(cwd, '_config.yml')) && /jekyll/.test(readFileSync(join(cwd, 'Gemfile'), 'utf8'))) {
      return { command: 'bundle exec jekyll serve', dir: cwd }
    }
  } catch {
    // not Jekyll
  }
  if (['hugo.toml', 'hugo.yaml', 'hugo.json'].some((f) => existsSync(join(cwd, f)))) {
    return { command: 'hugo server', dir: cwd }
  }
  return null
}

/** A plan as the one command line the UI shows. */
export function planLabel(plan: DevPlan, cwd: string): string {
  const rel = relative(cwd, plan.dir)
  return rel ? `cd ${rel} && ${plan.command}` : plan.command
}
