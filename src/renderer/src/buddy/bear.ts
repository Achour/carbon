/**
 * The bear, as one inline SVG. Every mood is the same drawing with parts shown
 * or hidden and animated by `buddy.css` off the stage's `data-mood`, so a mood
 * change is a class flip rather than a redraw.
 *
 * Drawn in a 760-unit box (≈0.21 px a unit at 160 px), so the CSS's stroke
 * widths, transform origins and keyframe distances are in those units too.
 */
export const BEAR_SVG = `
<svg id="bear" viewBox="-80 -10 760 760" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse class="shadow" cx="290" cy="736" rx="210" ry="16" />

  <g class="zzz">
    <text x="560" y="170">z</text>
    <text x="608" y="100">z</text>
    <text x="652" y="30">z</text>
  </g>
  <g class="sparkles">
    <g transform="translate(-40 170) scale(4.5)"><path d="M0 -12 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 l9 -3 z" /></g>
    <g transform="translate(610 60) scale(3.5)"><path d="M0 -12 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 l9 -3 z" /></g>
    <g transform="translate(630 400) scale(3)"><path d="M0 -12 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 l9 -3 z" /></g>
  </g>
  <g class="hearts">
    <g transform="translate(-30 150) scale(4.5)"><path d="M0 -4 c-4 -6 -13 -2 -9 5 l9 9 l9 -9 c4 -7 -5 -11 -9 -5 z" /></g>
    <g transform="translate(610 60) scale(3.5)"><path d="M0 -4 c-4 -6 -13 -2 -9 5 l9 9 l9 -9 c4 -7 -5 -11 -9 -5 z" /></g>
  </g>
  <g class="alert">
    <rect x="592" y="30" width="40" height="120" rx="20" />
    <circle cx="612" cy="196" r="22" />
  </g>

  <g class="bear">
    <g class="body">
      <path class="fur arm arm-left" d="M130 460 C62 450 24 484 34 522 C44 556 96 560 132 546 Z" />
      <path class="fur arm arm-right-rest" d="M452 458 C520 462 558 492 548 528 C538 562 488 566 456 550 Z" />
      <path class="fur" d="M112 440 C92 520 100 610 140 670 C160 705 190 720 230 720 L380 720 C425 718 452 690 462 650 C478 590 478 520 466 440 Z" />
      <ellipse class="foot" cx="214" cy="712" rx="52" ry="24" />
      <ellipse class="foot" cx="364" cy="712" rx="48" ry="24" />
      <path class="collar" d="M212 452 C212 492 224 516 248 514 C262 512 270 502 274 492 C280 506 292 516 308 513 C332 508 338 482 338 452 Z" />
    </g>

    <g class="head">
      <circle class="ear" cx="105" cy="70" r="56" />
      <path class="fur" d="M285 22 C430 22 548 90 558 210 C566 300 548 380 505 425 C470 458 400 462 290 462 C170 462 85 455 50 420 C15 385 10 300 16 220 C25 100 140 22 285 22 Z" />
      <circle class="ear" cx="496" cy="98" r="58" />

      <circle class="cheek" cx="64" cy="364" r="40" />
      <circle class="cheek" cx="412" cy="388" r="50" />

      <g class="eyes open-eyes">
        <circle class="eye" cx="135" cy="308" r="25" />
        <circle class="eye" cx="338" cy="320" r="25" />
      </g>
      <g class="eyes happy-eyes">
        <path d="M106 318 q29 -38 58 0" />
        <path d="M309 330 q29 -38 58 0" />
      </g>
      <g class="eyes sleep-eyes">
        <path d="M106 306 q29 24 58 0" />
        <path d="M309 318 q29 24 58 0" />
      </g>

      <g class="mouth mouth-small">
        <path class="tongue mouth-line" d="M216 326 C213 360 222 384 238 384 C254 384 262 360 258 326 Q248 336 237 328 Q226 336 216 326 Z" />
        <path class="mouth-line" d="M205 316 Q206 330 216 326 M269 316 Q268 330 258 326" />
      </g>
      <g class="mouth mouth-open">
        <path class="tongue mouth-line" d="M210 326 C205 378 220 402 238 402 C256 402 271 378 266 326 Q252 338 238 328 Q224 338 210 326 Z" />
        <path class="mouth-line" d="M199 315 Q200 330 210 326 M277 315 Q276 330 266 326" />
      </g>
    </g>

    <g class="laptop">
      <path class="laptop-lid" d="M182 520 h216 a16 16 0 0 1 16 16 v130 h-248 v-130 a16 16 0 0 1 16 -16 z" />
      <circle class="laptop-logo" cx="290" cy="598" r="15" />
      <rect class="laptop-base" x="128" y="664" width="324" height="26" rx="13" />
      <ellipse class="fur paw paw-left" cx="196" cy="660" rx="38" ry="26" />
      <ellipse class="fur paw paw-right" cx="384" cy="660" rx="38" ry="26" />
    </g>

    <!-- The raised paw, shown only while waving. -->
    <path class="fur arm arm-right" d="M452 476 C470 430 505 392 532 402 C560 412 552 456 515 498 C498 516 470 518 452 476 Z" />
  </g>
</svg>`
