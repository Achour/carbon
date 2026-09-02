/**
 * The alert cues, synthesized.
 *
 * Carbon ships no audio files, for the reason it ships no provider CLIs and no
 * language servers: a `.wav` is a frozen decision you can only replace, where
 * this is ~40 lines of numbers anyone can retune. It also keeps the app clear of
 * sampled sounds whose licensing is someone else's to grant.
 *
 * **Motif carries meaning, pack carries voice.** The three cues are three fixed
 * shapes — up a fifth, a repeated knock, a low fall — expressed as intervals
 * rather than pitches, so a user who changes the pack still hears "finished"
 * and "you're needed" as the same two gestures. Otherwise a pack is a rename of
 * every alert in the app.
 *
 * The predecessor was two sine oscillators, and that is exactly what it sounded
 * like. What separates a chime from a beep is not the notes: it is that a struck
 * object rings on *several* partials whose upper ones die first, so the tone
 * mellows as it fades. Sines have no partials and one decay rate, so they arrive
 * and stop, and no choice of pitch rescues them. Hence `Timbre.partials` — a
 * ratio, a level and a decay scale each — plus a short room tail, which is the
 * other half of why a sample sounds "designed" and a raw oscillator does not.
 *
 * A later attempt replaced all of this with a low, slow, heavily lowpassed voice
 * matched to the *aggregate* spectrum of Cursor's and macOS's cues — 255 Hz,
 * 109 ms swell, nothing above 3 kHz. It measured beautifully and sounded far
 * worse: a notification needs attack definition and air to read as a ding rather
 * than a hum, and whole-file spectral statistics capture neither. That is why
 * this file is bright and fast, and why matching a summary statistic is not the
 * same as matching a sound.
 */

export type CueKind = 'complete' | 'attention' | 'error'
export type SoundPackId = 'chime' | 'marimba' | 'bell' | 'pebble'

/** `[ratio to the fundamental, level, decay scale]`. */
type PartialSpec = readonly [number, number, number]

interface Timbre {
  partials: readonly PartialSpec[]
  /** Seconds to peak. Never 0 — an instant edge is a click, which reads as a fault. */
  attack: number
  /** Multiplies every motif length: how long the voice rings. */
  sustain: number
  /** Reverb send, 0–1. */
  space: number
  /** Lowpass over the whole cue, Hz — takes the glare off the top partials. */
  tone: number
}

export interface SoundPack {
  id: SoundPackId
  name: string
  description: string
  /** Hz of the motif's root note. */
  base: number
  /** Peak level of one note's fundamental. */
  level: number
  timbre: Timbre
}

/** One note of a motif: an interval from the pack's root, not a pitch. */
interface Step {
  semitones: number
  /** Seconds after the cue starts. */
  at: number
  /** Ring time before the pack's `sustain` scales it. */
  length: number
}

/**
 * Three gestures, and they are deliberately unlike each other in *contour*
 * rather than in pitch alone: rising, repeating, falling. Contour survives a
 * change of voice, a laptop speaker and a room with someone else in it, which
 * is the whole claim of a distinct cue — you should know whether to walk over
 * without looking at the screen.
 */
const MOTIFS: Record<CueKind, { steps: readonly Step[]; level: number }> = {
  // Up a perfect fifth: the most unambiguously settled two-note figure there is.
  complete: {
    steps: [
      { semitones: 0, at: 0, length: 1 },
      { semitones: 7, at: 0.105, length: 1.3 }
    ],
    level: 1
  },
  // A knock — same note twice, lower and closer together. Repetition is what
  // reads as "waiting on you" where a single tone reads as "here's the news".
  attention: {
    steps: [
      { semitones: -5, at: 0, length: 0.7 },
      { semitones: -5, at: 0.15, length: 1.05 }
    ],
    level: 0.95
  },
  // Down a fourth, an octave below the root, and quiet: a failure should be
  // audible from the next room without being the loudest thing the app does.
  error: {
    steps: [
      { semitones: -12, at: 0, length: 0.85 },
      { semitones: -17, at: 0.135, length: 1.2 }
    ],
    level: 0.72
  }
}

export const SOUND_PACKS: readonly SoundPack[] = [
  {
    id: 'chime',
    name: 'Chime',
    description: 'Soft glass, with air around it',
    base: 880,
    level: 0.115,
    timbre: {
      // Slightly stretched from whole numbers: struck glass is never exactly
      // harmonic, and the small detune is most of what stops this reading as an
      // organ note.
      partials: [
        [1, 1, 1],
        [2.01, 0.34, 0.68],
        [3.02, 0.13, 0.46],
        [4.97, 0.05, 0.3]
      ],
      attack: 0.006,
      sustain: 1,
      space: 0.34,
      tone: 6200
    }
  },
  {
    id: 'marimba',
    name: 'Marimba',
    description: 'Warm wood, short and dry',
    base: 659.25,
    level: 0.15,
    timbre: {
      // A marimba bar is undercut to tune its overtones to the 4th and 10th
      // harmonics — two octaves and three octaves-plus-a-third above. That gap
      // is the woody hollowness; even harmonics in between would make it a flute.
      partials: [
        [1, 1, 1],
        [3.99, 0.26, 0.34],
        [9.96, 0.07, 0.18]
      ],
      attack: 0.004,
      sustain: 0.5,
      space: 0.16,
      tone: 4600
    }
  },
  {
    id: 'bell',
    name: 'Bell',
    description: 'Deeper, with a long tail',
    base: 523.25,
    level: 0.1,
    timbre: {
      // Tubular-bell ratios, including the hum note a fifth *below* the strike.
      // The inharmonic 1.19 and 1.56 are the shimmer; drop them and it is a pad.
      partials: [
        [0.5, 0.28, 1.35],
        [1, 1, 1],
        [1.19, 0.42, 0.82],
        [1.56, 0.26, 0.66],
        [2, 0.34, 0.56],
        [2.66, 0.12, 0.36]
      ],
      attack: 0.008,
      sustain: 1.55,
      space: 0.45,
      tone: 5200
    }
  },
  {
    id: 'pebble',
    name: 'Pebble',
    description: 'Barely there — two soft taps',
    base: 987.77,
    level: 0.16,
    timbre: {
      partials: [
        [1, 1, 1],
        [2.4, 0.12, 0.4]
      ],
      attack: 0.005,
      sustain: 0.26,
      space: 0.06,
      tone: 2800
    }
  }
]

export const DEFAULT_SOUND_PACK: SoundPackId = 'chime'

/**
 * Coerce a pack id read off disk, the way `knownProvider` coerces a provider.
 * `localStorage` outlives any one build, so a pack this version has never heard
 * of has to fall back rather than leave the picker with nothing selected and
 * every cue silent.
 */
export function knownSoundPack(value: unknown): SoundPackId {
  return SOUND_PACKS.some((p) => p.id === value) ? (value as SoundPackId) : DEFAULT_SOUND_PACK
}

function packById(id: SoundPackId): SoundPack {
  return SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0]
}

/** Seconds of room tail after the last note stops ringing. */
const REVERB_SECONDS = 1.3

/**
 * A small bright room, generated rather than loaded: exponentially decaying
 * noise, decorrelated across the two channels so the tail has width. Built once
 * per context — 1.3s of stereo float is trivial, but not per cue.
 */
function impulseResponse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * REVERB_SECONDS))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.4)
    }
  }
  return buffer
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>()

function reverbFor(ctx: BaseAudioContext): AudioBuffer {
  let ir = impulses.get(ctx)
  if (!ir) {
    ir = impulseResponse(ctx)
    impulses.set(ctx, ir)
  }
  return ir
}

/** Seconds until a cue has fully faded, room tail included. */
function cueSeconds(kind: CueKind, id: SoundPackId): number {
  const { timbre } = packById(id)
  let last = 0
  for (const step of MOTIFS[kind].steps) {
    for (const [, , decayScale] of timbre.partials) {
      last = Math.max(last, step.at + timbre.attack + step.length * timbre.sustain * decayScale)
    }
  }
  return last + (timbre.space > 0 ? REVERB_SECONDS : 0) + 0.1
}

/**
 * Schedule one cue into `out`.
 *
 * Split from the playback path so the same graph can be rendered into an
 * `OfflineAudioContext` — which is how the levels above are checked rather than
 * guessed at (see `renderCue`).
 */
function buildCue(ctx: BaseAudioContext, out: AudioNode, kind: CueKind, id: SoundPackId): void {
  const pack = packById(id)
  const motif = MOTIFS[kind]
  const { timbre } = pack
  const t0 = ctx.currentTime

  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = timbre.tone
  tone.Q.value = 0.7
  tone.connect(out)

  if (timbre.space > 0) {
    // The wet path is darker than the dry one: a bright tail is what makes
    // reverb sound like an effect instead of like a room.
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 2600
    const send = ctx.createGain()
    send.gain.value = timbre.space
    const verb = ctx.createConvolver()
    verb.buffer = reverbFor(ctx)
    tone.connect(damp).connect(verb).connect(send).connect(out)
  }

  for (const step of motif.steps) {
    const freq = pack.base * Math.pow(2, step.semitones / 12)
    const ring = step.length * timbre.sustain
    for (const [ratio, level, decayScale] of timbre.partials) {
      const partialFreq = freq * ratio
      // Past Nyquist an oscillator aliases back down as an audible whistle at
      // an unrelated pitch. Bell's 2.66 partial on a high root gets close.
      if (partialFreq >= ctx.sampleRate / 2) continue
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = partialFreq
      const gain = ctx.createGain()
      const peak = pack.level * motif.level * level
      const decay = ring * decayScale
      const start = t0 + step.at
      // exponentialRamp throws on 0 and is silent from 0, hence the floors.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(peak, start + timbre.attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + timbre.attack + decay)
      osc.connect(gain).connect(tone)
      osc.start(start)
      osc.stop(start + timbre.attack + decay + 0.02)
    }
  }
}

// ---- Playback ----
//
// **A cue is rendered ahead of time, and the turn's end plays a buffer.**
// It used to build the graph on the live context at the moment it was
// wanted, which put ~80 ms on the main thread at the one instant the transcript
// is settling: `new AudioContext()` is ~67 ms the first time (the output
// stream), and setting a ConvolverNode's buffer is ~25 ms on *every* cue,
// because Chromium partitions the impulse for FFT convolution synchronously on
// the setter. Measured with `AIGUI_PROFILE` on a real turn, that was the single
// long task left in a turn — the completion chime dropping the frame the
// completion landed on.
//
// So each (pack, kind) is rendered **offline** once — the same `buildCue`
// graph into an `OfflineAudioContext`, whose render runs off the main thread —
// and playing is a buffer source, which costs nothing. `warmCues` does the
// render, and the one-off context creation, on idle after launch, so the first
// turn of a session pays neither; a cue that was never warmed still renders on
// demand and lands a few tens of milliseconds late rather than early.

/** The offline render rate. A live context at another rate resamples the buffer. */
const RENDER_RATE = 48000

const rendered = new Map<string, Promise<AudioBuffer>>()

/** One cue as audio, rendered once per (pack, kind) and cached for the session. */
function cueBuffer(kind: CueKind, pack: SoundPackId): Promise<AudioBuffer> {
  const key = `${pack}:${kind}`
  let pending = rendered.get(key)
  if (!pending) {
    const ctx = new OfflineAudioContext(2, Math.ceil(RENDER_RATE * cueSeconds(kind, pack)), RENDER_RATE)
    buildCue(ctx, ctx.destination, kind, pack)
    pending = ctx.startRendering()
    rendered.set(key, pending)
    // A failed render is not cached: the next request tries again.
    pending.catch(() => rendered.delete(key))
  }
  return pending
}

let audio: AudioContext | null = null
let audioIdle: ReturnType<typeof setTimeout> | null = null
let idleAt = 0

/**
 * The live output. A running AudioContext holds a realtime output stream open
 * forever (~100 silent callbacks/s across the renderer and coreaudiod, and it
 * blocks process idling), so it is woken just for a cue and suspended once the
 * tail has faded — the cue's *own* length, since Bell rings for over three
 * seconds and a fixed timer would cut it off mid-decay.
 */
function liveContext(): AudioContext {
  audio ??= new AudioContext()
  return audio
}

function keepAwake(seconds: number): void {
  // Overlapping cues: the later suspend wins, never the earlier one.
  const until = Date.now() + seconds * 1000
  if (until > idleAt || !audioIdle) {
    idleAt = until
    if (audioIdle) clearTimeout(audioIdle)
    audioIdle = setTimeout(() => void audio?.suspend(), seconds * 1000)
  }
}

/** Play one cue in the given pack. Never throws — audio is not worth a crash. */
export function playCue(kind: CueKind, pack: SoundPackId = DEFAULT_SOUND_PACK): void {
  try {
    const ctx = liveContext()
    void cueBuffer(kind, pack)
      .then((buffer) => {
        if (ctx.state === 'suspended') void ctx.resume()
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(ctx.destination)
        source.start()
        keepAwake(buffer.duration + 0.1)
      })
      .catch(() => undefined)
    // The other cues of this pack are the next thing likely to be wanted.
    warmCues(pack)
  } catch {
    // audio unavailable — never block the event flow over a chime
  }
}

const warmed = new Set<SoundPackId>()

/**
 * Render a pack's cues and open the output ahead of the first turn's end, one
 * step per idle callback so a busy launch is never made busier. Idempotent per
 * pack; the on-demand path in `playCue` covers whatever this has not reached.
 */
export function warmCues(pack: SoundPackId): void {
  if (warmed.has(pack)) return
  warmed.add(pack)
  const steps: (() => void)[] = [
    () => {
      // Creating the context opens the output stream, which is the 67 ms; it
      // is suspended straight away, so this costs no idle CPU afterwards.
      if (!audio) void liveContext().suspend()
    },
    ...(Object.keys(MOTIFS) as CueKind[]).map((kind) => () => void cueBuffer(kind, pack))
  ]
  let next = 0
  const step = (): void => {
    const run = steps[next++]
    if (!run) return
    try {
      run()
    } catch {
      // see playCue
    }
    whenIdle(step)
  }
  whenIdle(step)
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 1_000)
}

/**
 * Render a cue offline and report its levels. Dev-only, and the reason the
 * numbers above can be asserted rather than eyeballed: taste is the user's,
 * but clipping is objectively wrong, and packs that jump in loudness make the
 * picker unusable.
 */
export async function renderCue(
  kind: CueKind,
  pack: SoundPackId
): Promise<{ peak: number; rms: number; seconds: number }> {
  const buffer = await cueBuffer(kind, pack)
  let peak = 0
  let sum = 0
  let n = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
      sum += data[i] * data[i]
      n++
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), seconds: cueSeconds(kind, pack) }
}

if (import.meta.env.DEV) {
  ;(window as unknown as { __carbonRenderCue?: typeof renderCue }).__carbonRenderCue = renderCue
}
