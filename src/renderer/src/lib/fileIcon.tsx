/**
 * Filename → icon: the single definition behind every place the app names a
 * file (the tree, editor tabs, ⌘P search, @-mentions, composer attachments).
 *
 * **Shape says what kind of thing it is, color says which language.** An image,
 * an archive, a lockfile, a key, a database and a stylesheet each get their own
 * silhouette, because those are different *objects*; the twenty-odd source
 * languages share `FileCode` and are separated by hue instead. Giving each
 * language its own drawing is what makes icon themes turn into noise — at 14px
 * a column of distinct silhouettes reads as static, where one silhouette in
 * seven colors reads as a sorted list. The exceptions are the few marks more
 * recognisable than any color (React's orbit, Rust's gear, Java's cup, Ruby's
 * gem, Elixir's drop, Vue's triangle) and the two files this app is actually
 * about — `CLAUDE.md` and `AGENTS.md` get their provider's own mark, in the
 * brand color, since Carbon already owns both paths.
 *
 * Colors come from the `--icon-*` palette (`index.css`) rather than real brand
 * hues: those are picked to sing on a marketing page, and half of them are
 * illegible or shouty against a chat sidebar in one of the two modes.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Atom,
  Binary,
  BookText,
  Braces,
  Bird,
  CodeXml,
  Coffee,
  Cog,
  Container,
  Database,
  Droplet,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Flame,
  FlaskConical,
  Gem,
  GitBranch,
  Image,
  KeyRound,
  Lock,
  Music,
  Notebook,
  Package,
  Palette,
  Scale,
  ScrollText,
  Settings2,
  Shapes,
  Sheet,
  Film,
  Terminal,
  Triangle,
  Type,
  Wrench
} from 'lucide-react'
import type { Provider } from '@shared/types'
import { cn } from '@/lib/utils'
import { ProviderMark } from '@/components/ui/provider-mark'

const C = {
  blue: 'text-icon-blue',
  cyan: 'text-icon-cyan',
  green: 'text-icon-green',
  yellow: 'text-icon-yellow',
  orange: 'text-icon-orange',
  red: 'text-icon-red',
  purple: 'text-icon-purple',
  /** Everything with no language of its own: plain text, binaries, dotfiles. */
  muted: 'text-muted-foreground/70'
} as const

type Spec = { Icon: LucideIcon; color: string; provider?: never } | { provider: Provider }

/** Whole filenames, matched before any extension rule. Keys are lowercased. */
const BY_NAME: Record<string, Spec> = {
  'claude.md': { provider: 'claude' },
  'agents.md': { provider: 'codex' },
  'codex.md': { provider: 'codex' },

  'package.json': { Icon: Package, color: C.red },
  readme: { Icon: BookText, color: C.blue },
  'readme.md': { Icon: BookText, color: C.blue },
  'readme.txt': { Icon: BookText, color: C.blue },
  license: { Icon: Scale, color: C.muted },
  'license.md': { Icon: Scale, color: C.muted },
  'license.txt': { Icon: Scale, color: C.muted },
  licence: { Icon: Scale, color: C.muted },
  copying: { Icon: Scale, color: C.muted },

  dockerfile: { Icon: Container, color: C.blue },
  '.dockerignore': { Icon: Container, color: C.blue },
  'docker-compose.yml': { Icon: Container, color: C.blue },
  'docker-compose.yaml': { Icon: Container, color: C.blue },
  'compose.yml': { Icon: Container, color: C.blue },
  'compose.yaml': { Icon: Container, color: C.blue },

  '.gitignore': { Icon: GitBranch, color: C.orange },
  '.gitattributes': { Icon: GitBranch, color: C.orange },
  '.gitmodules': { Icon: GitBranch, color: C.orange },
  '.gitkeep': { Icon: GitBranch, color: C.orange },

  makefile: { Icon: Wrench, color: C.muted },
  gnumakefile: { Icon: Wrench, color: C.muted },
  justfile: { Icon: Wrench, color: C.muted },
  rakefile: { Icon: Wrench, color: C.muted },
  'cmakelists.txt': { Icon: Wrench, color: C.muted },

  // Generated and never hand-edited — dimmed on purpose, since a lockfile in a
  // language's color would be the loudest thing in most repo roots.
  'package-lock.json': { Icon: Lock, color: C.muted },
  'yarn.lock': { Icon: Lock, color: C.muted },
  'pnpm-lock.yaml': { Icon: Lock, color: C.muted },
  'bun.lock': { Icon: Lock, color: C.muted },
  'bun.lockb': { Icon: Lock, color: C.muted },
  'cargo.lock': { Icon: Lock, color: C.muted },
  'composer.lock': { Icon: Lock, color: C.muted },
  'gemfile.lock': { Icon: Lock, color: C.muted },
  'poetry.lock': { Icon: Lock, color: C.muted },
  'uv.lock': { Icon: Lock, color: C.muted },
  'go.sum': { Icon: Lock, color: C.muted },

  '.ds_store': { Icon: File, color: C.muted }
}

const BY_EXT: Record<string, Spec> = {
  // Source — one glyph, seven hues (see the module comment).
  ts: { Icon: FileCode, color: C.blue },
  mts: { Icon: FileCode, color: C.blue },
  cts: { Icon: FileCode, color: C.blue },
  js: { Icon: FileCode, color: C.yellow },
  mjs: { Icon: FileCode, color: C.yellow },
  cjs: { Icon: FileCode, color: C.yellow },
  tsx: { Icon: Atom, color: C.cyan },
  jsx: { Icon: Atom, color: C.cyan },
  vue: { Icon: Triangle, color: C.green },
  svelte: { Icon: Flame, color: C.orange },
  astro: { Icon: FileCode, color: C.purple },
  py: { Icon: FileCode, color: C.green },
  pyi: { Icon: FileCode, color: C.green },
  rb: { Icon: Gem, color: C.red },
  java: { Icon: Coffee, color: C.orange },
  kt: { Icon: FileCode, color: C.purple },
  kts: { Icon: FileCode, color: C.purple },
  swift: { Icon: Bird, color: C.orange },
  go: { Icon: FileCode, color: C.cyan },
  rs: { Icon: Cog, color: C.orange },
  c: { Icon: FileCode, color: C.blue },
  h: { Icon: FileCode, color: C.blue },
  cpp: { Icon: FileCode, color: C.blue },
  cc: { Icon: FileCode, color: C.blue },
  cxx: { Icon: FileCode, color: C.blue },
  hpp: { Icon: FileCode, color: C.blue },
  hh: { Icon: FileCode, color: C.blue },
  cs: { Icon: FileCode, color: C.purple },
  php: { Icon: FileCode, color: C.purple },
  lua: { Icon: FileCode, color: C.blue },
  dart: { Icon: FileCode, color: C.cyan },
  ex: { Icon: Droplet, color: C.purple },
  exs: { Icon: Droplet, color: C.purple },
  hs: { Icon: FileCode, color: C.purple },
  scala: { Icon: FileCode, color: C.red },
  r: { Icon: FileCode, color: C.blue },
  pl: { Icon: FileCode, color: C.blue },
  pm: { Icon: FileCode, color: C.blue },
  zig: { Icon: FileCode, color: C.orange },
  proto: { Icon: FileCode, color: C.blue },
  graphql: { Icon: FileCode, color: C.purple },
  gql: { Icon: FileCode, color: C.purple },
  ipynb: { Icon: Notebook, color: C.orange },
  wasm: { Icon: Binary, color: C.purple },

  // Shells and queries — a terminal is a different *thing*, not a dialect.
  sh: { Icon: Terminal, color: C.green },
  bash: { Icon: Terminal, color: C.green },
  zsh: { Icon: Terminal, color: C.green },
  fish: { Icon: Terminal, color: C.green },
  ps1: { Icon: FileTerminal, color: C.blue },
  bat: { Icon: FileTerminal, color: C.blue },
  cmd: { Icon: FileTerminal, color: C.blue },
  sql: { Icon: Database, color: C.blue },

  // Markup and style.
  html: { Icon: CodeXml, color: C.orange },
  htm: { Icon: CodeXml, color: C.orange },
  xhtml: { Icon: CodeXml, color: C.orange },
  xml: { Icon: CodeXml, color: C.muted },
  plist: { Icon: CodeXml, color: C.muted },
  css: { Icon: Palette, color: C.blue },
  pcss: { Icon: Palette, color: C.blue },
  postcss: { Icon: Palette, color: C.blue },
  scss: { Icon: Palette, color: C.purple },
  sass: { Icon: Palette, color: C.purple },
  less: { Icon: Palette, color: C.purple },
  styl: { Icon: Palette, color: C.purple },

  // Prose.
  md: { Icon: BookText, color: C.blue },
  mdx: { Icon: BookText, color: C.blue },
  markdown: { Icon: BookText, color: C.blue },
  txt: { Icon: FileText, color: C.muted },
  rst: { Icon: FileText, color: C.muted },
  adoc: { Icon: FileText, color: C.muted },
  pdf: { Icon: FileText, color: C.red },
  log: { Icon: ScrollText, color: C.muted },

  // Data and config.
  json: { Icon: Braces, color: C.yellow },
  jsonc: { Icon: Braces, color: C.yellow },
  json5: { Icon: Braces, color: C.yellow },
  yaml: { Icon: Settings2, color: C.purple },
  yml: { Icon: Settings2, color: C.purple },
  toml: { Icon: Settings2, color: C.orange },
  ini: { Icon: Settings2, color: C.muted },
  cfg: { Icon: Settings2, color: C.muted },
  conf: { Icon: Settings2, color: C.muted },
  properties: { Icon: Settings2, color: C.muted },
  csv: { Icon: Sheet, color: C.green },
  tsv: { Icon: Sheet, color: C.green },
  xls: { Icon: FileSpreadsheet, color: C.green },
  xlsx: { Icon: FileSpreadsheet, color: C.green },
  db: { Icon: Database, color: C.blue },
  sqlite: { Icon: Database, color: C.blue },
  sqlite3: { Icon: Database, color: C.blue },
  lock: { Icon: Lock, color: C.muted },

  // Media and assets.
  png: { Icon: Image, color: C.purple },
  jpg: { Icon: Image, color: C.purple },
  jpeg: { Icon: Image, color: C.purple },
  gif: { Icon: Image, color: C.purple },
  webp: { Icon: Image, color: C.purple },
  avif: { Icon: Image, color: C.purple },
  bmp: { Icon: Image, color: C.purple },
  ico: { Icon: Image, color: C.purple },
  tiff: { Icon: Image, color: C.purple },
  heic: { Icon: Image, color: C.purple },
  svg: { Icon: Shapes, color: C.purple },
  mp4: { Icon: Film, color: C.red },
  mov: { Icon: Film, color: C.red },
  webm: { Icon: Film, color: C.red },
  mkv: { Icon: Film, color: C.red },
  avi: { Icon: Film, color: C.red },
  m4v: { Icon: Film, color: C.red },
  mp3: { Icon: Music, color: C.red },
  wav: { Icon: Music, color: C.red },
  flac: { Icon: Music, color: C.red },
  ogg: { Icon: Music, color: C.red },
  m4a: { Icon: Music, color: C.red },
  aac: { Icon: Music, color: C.red },
  ttf: { Icon: Type, color: C.red },
  otf: { Icon: Type, color: C.red },
  woff: { Icon: Type, color: C.red },
  woff2: { Icon: Type, color: C.red },
  eot: { Icon: Type, color: C.red },

  // Archives, binaries, secrets.
  zip: { Icon: FileArchive, color: C.yellow },
  tar: { Icon: FileArchive, color: C.yellow },
  gz: { Icon: FileArchive, color: C.yellow },
  tgz: { Icon: FileArchive, color: C.yellow },
  bz2: { Icon: FileArchive, color: C.yellow },
  xz: { Icon: FileArchive, color: C.yellow },
  zst: { Icon: FileArchive, color: C.yellow },
  '7z': { Icon: FileArchive, color: C.yellow },
  rar: { Icon: FileArchive, color: C.yellow },
  dmg: { Icon: Binary, color: C.muted },
  exe: { Icon: Binary, color: C.muted },
  app: { Icon: Binary, color: C.muted },
  bin: { Icon: Binary, color: C.muted },
  so: { Icon: Binary, color: C.muted },
  dylib: { Icon: Binary, color: C.muted },
  dll: { Icon: Binary, color: C.muted },
  jar: { Icon: Binary, color: C.muted },
  class: { Icon: Binary, color: C.muted },
  map: { Icon: Binary, color: C.muted },
  pem: { Icon: KeyRound, color: C.yellow },
  key: { Icon: KeyRound, color: C.yellow },
  crt: { Icon: KeyRound, color: C.yellow },
  cer: { Icon: KeyRound, color: C.yellow },
  p12: { Icon: KeyRound, color: C.yellow },
  pfx: { Icon: KeyRound, color: C.yellow },
  asc: { Icon: KeyRound, color: C.yellow },
  gpg: { Icon: KeyRound, color: C.yellow }
}

/** `foo.test.ts`, `foo.spec.tsx` — matched before the extension rule. */
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

export function fileIconSpec(path: string): Spec {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const byName = BY_NAME[name]
  if (byName) return byName
  // Every `.env`, `.env.local`, `.env.production` — secrets, not config.
  if (name.startsWith('.env')) return { Icon: KeyRound, color: C.yellow }
  if (TEST_RE.test(name)) return { Icon: FlaskConical, color: C.green }
  const dot = name.lastIndexOf('.')
  // `dot > 0`, so `.gitignore` is a dotfile rather than a `gitignore` extension.
  const byExt = dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined
  if (byExt) return byExt
  // Unclaimed dotfiles are nearly always tool config (`.npmrc`, `.nvmrc`, …).
  if (name.startsWith('.')) return { Icon: Settings2, color: C.muted }
  return { Icon: File, color: C.muted }
}

/**
 * The icon for a file path or bare filename. `className` sets the size and can
 * override the color — a selected tab wants `currentColor`, not the palette.
 */
export function FileIcon({
  path,
  className
}: {
  path: string
  className?: string
}): React.JSX.Element {
  const spec = fileIconSpec(path)
  if (spec.provider) {
    return (
      <ProviderMark
        provider={spec.provider}
        className={cn(
          'size-3.5 shrink-0',
          spec.provider === 'claude' ? 'text-brand-claude' : 'text-brand-codex',
          className
        )}
      />
    )
  }
  const { Icon, color } = spec
  return <Icon className={cn('size-3.5 shrink-0', color, className)} />
}
