# The alert cues

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The alert cues (`lib/sounds.ts`)

Three sounds — a turn finished, a turn failed, the agent needs an answer — and
**Carbon ships no audio files**, for the reason it ships no provider CLIs and no
language servers. A `.wav` is a frozen decision you can only replace; this is a
table of numbers anyone can retune, and it keeps the app clear of sampled sounds
whose licensing is someone else's to grant.

- **Motif carries meaning, pack carries voice.** A cue is an interval pattern
  (`MOTIFS`) rendered through a timbre (`SOUND_PACKS`), so changing the pack
  changes how the app sounds and never what a sound *means*. The three contours
  are deliberately unlike each other in shape rather than in pitch alone —
  rising a fifth, a repeated knock, a low fall — because contour is what
  survives a laptop speaker and a room with someone else in it.
- **A struck object rings on several partials whose upper ones die first**, so
  the tone mellows as it fades. A sine has one partial and one decay rate, so it
  arrives and stops — which is why the original two-oscillator chime sounded like
  a beep and no choice of pitch would have rescued it. `Timbre.partials` (ratio,
  level, decay scale) plus a short generated room tail is the difference. The
  ratios are real instrument physics: a marimba bar is undercut to tune its
  overtones to the 4th and 10th harmonics, a tubular bell is frankly inharmonic.
- **A partial past Nyquist aliases back down** as an audible whistle at an
  unrelated pitch, so `buildCue` drops one rather than playing it. Bell's 2.66
  partial on a high root is the case that gets close.
- **The suspend-when-idle discipline times off the cue.** A running
  `AudioContext` holds a realtime output stream open forever, so it is woken per
  cue and suspended after — but the fixed 1200 ms it inherited was written for a
  450 ms beep, and Bell rings for over four seconds. `cueSeconds` is the same
  arithmetic the offline render uses, so the timer cannot drift from the sound.
- **A cue is rendered ahead of time; the turn's end plays a buffer.** Built on
  the live context at the moment it was wanted, the completion chime was the
  one long task left in a real turn — ~80 ms on the frame the reply settled,
  found with `AIGUI_PROFILE`: `new AudioContext()` is ~67 ms once (the output
  stream) and setting a ConvolverNode's buffer ~25 ms on *every* cue, since
  Chromium partitions the impulse for FFT convolution synchronously on the
  setter. `cueBuffer` renders each (pack, kind) once through the same
  `buildCue` graph into an `OfflineAudioContext` — off the main thread — and
  `playCue` is then a buffer source at ~0.1 ms. `warmCues` does the renders and
  the one-off context creation on idle after launch (`App`, only when sound is
  on), one per idle callback like `preloadHeavy`; a cue nothing warmed still
  renders on demand and lands a few tens of milliseconds late rather than
  early. `renderCue`, the dev-only level checker, reads the same cache.
- **A stopped turn stays silent.** The failure cue rides the existing `error`
  event, and all three adapters already suppress that event on an intentional
  interrupt (`interruptedTurn` / `interrupted`) — so cancelling never dings.

**A rewrite matched to measured spectra was tried and was much worse, and that
is the most useful thing in this section.** Decoding Cursor's, VS Code's and
macOS's own cues says they sit at 250–330 Hz with the spectral centroid around
400–650 Hz, almost nothing above 3 kHz, and attacks of 127–638 ms — where this
file is bright and fast. Rebuilding to those numbers (255 Hz, 109 ms swell,
detuned cluster, lowpass sweeping to 620 Hz, no reverb) hit every target and
sounded dramatically worse: a low, slow, heavily lowpassed voice reads as a hum,
not a notification. **Whole-file spectral statistics are not a description of a
sound.** They average away exactly what a cue is made of — the transient at the
onset, the air in the tail, the attack definition that makes a ding a ding — and
Cursor's own `done1` carries a 2 kHz transient at ~100 ms that its 1161 Hz
centroid says nothing about. Measurement was still worth doing; treating a
matched summary statistic as a matched sound was the error. If this is revisited,
the loop that decides is a person listening, and the metrics are a guardrail
against clipping and loudness jumps — which is all `renderCue` claims.

The picker is a grid rather than a dropdown, for `ThemeGrid`'s reason at one
remove: sounds cannot be compared side by side, so the next best thing is having
every one a single click away, and selecting *is* the preview. It stays live when
Sound is off — a click there is an explicit request to hear something — and the
three cues audition separately, because the question a user actually has is
whether "finished" and "needs you" are far enough apart, which is about the pair
rather than either one.
