/// <reference lib="dom" />
// The runtime below is source text for the *page*; the DOM types are for
// writing it, and nothing in main touches a DOM at run time.
/**
 * The half of the preview's agent tools that runs *inside the page*.
 *
 * `carbonAgentRuntime` is stringified and evaluated in the guest's main world
 * over CDP, installing `window.__carbonAgent` once per document. Everything it
 * needs lives inside the function body — it is source text by the time it
 * runs, so a closure over anything in this module would be a `ReferenceError`
 * in the page.
 *
 * **Refs are the contract between a snapshot and an action.** `snapshot` hands
 * every element it lists a stable `eN` (a `WeakMap`, so the same element keeps
 * its ref across snapshots and a re-render that replaces a node gives the new
 * one a new ref), and `click`/`type`/`scroll` resolve that ref back to the
 * element. A ref whose element has left the DOM says so instead of acting on
 * whatever now sits at the old coordinates.
 *
 * Names follow the accessible-name rules closely enough to be what a screen
 * reader would say — `aria-label`, `aria-labelledby`, `<label for>`, a wrapping
 * label, `alt`, then text — because that is the vocabulary a model already
 * uses to describe a UI, and the one `text` targeting matches against.
 */

/* eslint-disable */
export function carbonAgentRuntime(): unknown {
  const w = window as any
  if (w.__carbonAgent) return w.__carbonAgent

  // Refs are `<doc>:eN`. The document token is what stops a ref from an
  // earlier page resolving on this one — each document numbers from e1, so
  // without it an old `e1` would name an unrelated element after a
  // navigation. The driver shows the model short `eN` aliases and keeps the
  // mapping (`previewDriver.ts`).
  const doc = Math.random().toString(36).slice(2, 8)
  const refOf = new WeakMap<Element, string>()
  const byRef = new Map<string, WeakRef<Element>>()
  let nextRef = 1
  const refFor = (el: Element): string => {
    let r = refOf.get(el)
    if (!r) {
      r = doc + ':e' + nextRef++
      refOf.set(el, r)
    }
    byRef.set(r, new WeakRef(el))
    return r
  }
  /** Drops entries whose element has been collected, so an SPA's churn cannot grow the map forever. */
  const prune = (): void => {
    for (const [r, w] of byRef) if (!w.deref()) byRef.delete(r)
  }

  /**
   * What holds focus, through shadow roots: `document.activeElement` stops at
   * the outermost host, so a focused button inside a component read as the
   * component, and typing with no target went to the host.
   */
  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement
    while (a && a.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
    return a
  }
  const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim()
  const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

  const INTERACTIVE = new Set([
    'link', 'button', 'checkbox', 'radio', 'slider', 'spinbutton', 'searchbox', 'textbox', 'combobox',
    'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'treeitem', 'clickable'
  ])
  const CONTAINERS = new Set([
    'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog', 'region',
    'list', 'listitem', 'table', 'row', 'menu', 'menubar', 'tablist', 'tabpanel', 'group', 'toolbar', 'search'
  ])

  const styleOf = (el: Element): CSSStyleDeclaration => getComputedStyle(el)
  const isHidden = (el: Element): boolean => {
    if ((el as HTMLElement).hidden) return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    const s = styleOf(el)
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0'
  }
  const hasBox = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const roleOf = (el: Element): string | null => {
    const explicit = norm(el.getAttribute('role')).split(' ')[0]
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null
      case 'button':
      case 'summary':
        return 'button'
      case 'select':
        return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox'
      case 'option':
        return 'option'
      case 'textarea':
        return 'textbox'
      case 'input': {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase()
        if (t === 'hidden') return null
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image' || t === 'file') return 'button'
        if (t === 'checkbox') return el.getAttribute('switch') !== null ? 'switch' : 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'range') return 'slider'
        if (t === 'number') return 'spinbutton'
        if (t === 'search') return 'searchbox'
        return 'textbox'
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return 'heading'
      case 'img':
        return el.getAttribute('alt') ? 'img' : null
      case 'nav': return 'navigation'
      case 'main': return 'main'
      case 'header': return el.closest('article, section, main, aside, nav') ? null : 'banner'
      case 'footer': return el.closest('article, section, main, aside, nav') ? null : 'contentinfo'
      case 'aside': return 'complementary'
      case 'form': return 'form'
      case 'dialog': return 'dialog'
      case 'ul': case 'ol': return 'list'
      case 'li': return 'listitem'
      case 'table': return 'table'
      case 'tr': return 'row'
      case 'fieldset': return 'group'
      case 'search': return 'search'
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null
      case 'iframe': return 'iframe'
      case 'video': return 'video'
      case 'audio': return 'audio'
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox'
    const tabindex = el.getAttribute('tabindex')
    if (tabindex !== null && Number(tabindex) >= 0) return 'clickable'
    // A div with an onClick is invisible to the DOM — React attaches its
    // listeners at the root — but it almost always wears `cursor: pointer`.
    // Only the outermost such element, or every span inside a card would be
    // its own "clickable".
    if (styleOf(el).cursor === 'pointer' && !(el.parentElement && styleOf(el.parentElement).cursor === 'pointer')) {
      return 'clickable'
    }
    return null
  }

  const textOfIds = (ids: string): string =>
    ids
      .split(/\s+/)
      .map((id) => norm(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(' ')

  const labelText = (el: Element): string => {
    const id = el.getAttribute('id')
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]')
      if (lab) return norm((lab as HTMLElement).innerText || lab.textContent)
    }
    const wrap = el.closest('label')
    if (wrap) {
      const clone = wrap.cloneNode(true) as HTMLElement
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove())
      return norm(clone.textContent)
    }
    return ''
  }

  const nameOf = (el: Element, role: string | null): string => {
    const aria = el.getAttribute('aria-label')
    if (aria && norm(aria)) return norm(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = textOfIds(by)
      if (t) return t
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const t = ((el as HTMLInputElement).type || '').toLowerCase()
      if (t === 'submit' || t === 'button' || t === 'reset') return norm((el as HTMLInputElement).value) || t
      const l = labelText(el)
      if (l) return l
      return norm(el.getAttribute('title')) || norm(el.getAttribute('name'))
    }
    if (tag === 'img') return norm(el.getAttribute('alt'))
    if (role && (INTERACTIVE.has(role) || role === 'heading' || role === 'option' || role === 'listitem')) {
      const t = norm((el as HTMLElement).innerText || el.textContent)
      if (t) return t
      const svgTitle = el.querySelector('svg title')
      if (svgTitle) return norm(svgTitle.textContent)
      const img = el.querySelector('img[alt]')
      if (img) return norm(img.getAttribute('alt'))
    }
    return norm(el.getAttribute('title'))
  }

  const describe = (el: Element | null): string => {
    if (!el) return 'nothing'
    const role = roleOf(el)
    const name = cap(nameOf(el, role), 60)
    if (role && name) return role + ' "' + name + '"'
    let s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2) : []
    if (cls.length && cls[0]) s += '.' + cls.join('.')
    return role ? role + ' <' + s + '>' : '<' + s + '>'
  }

  const statesOf = (el: Element, role: string): string[] => {
    const out: string[] = []
    const input = el as HTMLInputElement
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const aria = el.getAttribute('aria-checked')
      if (input.checked || aria === 'true') out.push('checked')
      else if (aria === 'mixed' || input.indeterminate) out.push('mixed')
    }
    if ((input as any).disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    const exp = el.getAttribute('aria-expanded')
    if (exp !== null) out.push('expanded=' + exp)
    if (el.getAttribute('aria-selected') === 'true' || (role === 'option' && (el as HTMLOptionElement).selected)) out.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed')
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current')
    if ((input as any).required || el.getAttribute('aria-required') === 'true') out.push('required')
    if (el.getAttribute('aria-invalid') === 'true') out.push('invalid')
    if (deepActive() === el) out.push('focused')
    return out
  }

  const attrsOf = (el: Element, role: string): string[] => {
    const out: string[] = []
    const tag = el.tagName.toLowerCase()
    if (role === 'heading') out.push('level=' + (Number(tag.slice(1)) || el.getAttribute('aria-level') || 2))
    if (role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript:')) out.push('→ ' + cap(href, 80))
    }
    if (tag === 'input' || tag === 'textarea') {
      const i = el as HTMLInputElement
      const t = (i.type || 'text').toLowerCase()
      if (t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'button') {
        if (t !== 'text' && t !== 'textarea' && tag === 'input') out.push('type=' + t)
        const ph = el.getAttribute('placeholder')
        if (ph) out.push('placeholder=' + JSON.stringify(cap(ph, 60)))
        out.push('value=' + JSON.stringify(t === 'password' ? (i.value ? '••••' : '') : cap(i.value, 80)))
      }
    } else if (tag === 'select') {
      const s = el as HTMLSelectElement
      const chosen = s.selectedOptions && s.selectedOptions[0]
      out.push('value=' + JSON.stringify(chosen ? norm(chosen.text) : ''))
      const opts = Array.prototype.slice.call(s.options, 0, 12).map((o: HTMLOptionElement) => norm(o.text))
      out.push('options=' + JSON.stringify(opts) + (s.options.length > 12 ? '…' : ''))
    } else if ((el as HTMLElement).isContentEditable) {
      out.push('value=' + JSON.stringify(cap(norm((el as HTMLElement).innerText), 80)))
    } else if (role === 'slider' || role === 'spinbutton') {
      const v = el.getAttribute('aria-valuenow')
      if (v) out.push('value=' + v)
    }
    return out
  }

  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }

  const PHRASING = new Set([
    'span', 'b', 'i', 'em', 'strong', 'code', 'small', 'sup', 'sub', 'mark', 'abbr', 'time', 'br', 's', 'u',
    'kbd', 'q', 'cite', 'var', 'samp', 'data', 'wbr', 'del', 'ins', 'bdi', 'bdo'
  ])
  /**
   * An element whose children are all inline text markup — a paragraph with a
   * `<strong>` in it, or a heading animated one `<span>` per letter. Its text
   * is read whole: its own text nodes alone would be "", and each span alone a
   * single letter.
   */
  const onlyPhrasing = (el: Element, depth = 0): boolean => {
    if (depth > 4) return false
    for (const c of Array.from(el.children)) {
      if (!PHRASING.has(c.tagName.toLowerCase()) || roleOf(c)) return false
      if (c.children.length && !onlyPhrasing(c, depth + 1)) return false
    }
    return true
  }

  /** Text a non-interactive element holds directly — its own text nodes. */
  const ownText = (el: Element): string => {
    let s = ''
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent
    return norm(s)
  }

  /**
   * Shown, counting every ancestor: a closed dialog's buttons are still
   * connected, and `aria-hidden` on a shadow host hides its whole tree, which
   * `closest()` cannot see across.
   */
  const shownDeep = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement || (((n.getRootNode() as ShadowRoot).host as Element | undefined) ?? null)) {
      if (n.getAttribute('aria-hidden') === 'true') return false
    }
    const e = el as Element & { checkVisibility?: (o: object) => boolean }
    return e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : !isHidden(el)
  }

  /** Always floating: the top layer, and what declares itself modal. */
  const TOP_LAYER = '[aria-modal="true"], dialog[open], :popover-open'
  /** Floating only when laid out in a fixed or absolute layer; in the flow they read in place. */
  const MAYBE_FLOATING =
    '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-live="polite"], [aria-live="assertive"]'
  /**
   * The document and every open shadow root in it, nested ones included —
   * what `querySelectorAll` on the document alone cannot see into, and the
   * snapshot's walk does. Bounded: finding them reads no styles, only each
   * element's own `shadowRoot`.
   */
  const openRoots = (): (Document | ShadowRoot)[] => {
    const roots: (Document | ShadowRoot)[] = [document]
    const all = document.querySelectorAll('*')
    for (let i = 0; i < all.length && i < 60000; i++) {
      const sr = all[i].shadowRoot
      if (sr) roots.push(sr)
    }
    for (let r = 1; r < roots.length && r < 200; r++) {
      for (const el of Array.from(roots[r].querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot)
    }
    return roots
  }
  /** First match for a selector in the document, else in an open shadow root. */
  const queryDeep = (sel: string): Element | null => {
    const hit = document.querySelector(sel)
    if (hit) return hit
    for (const r of openRoots().slice(1)) {
      const el = r.querySelector(sel)
      if (el) return el
    }
    return null
  }

  /** The composed parent: across a shadow boundary, the host. */
  const up = (n: Element): Element | null => n.parentElement || (((n.getRootNode() as ShadowRoot).host as Element | undefined) ?? null)
  /**
   * What floats over the page — dialogs, toasts, menus — outermost only.
   * Portals put these at the end of `<body>`, which on a long page is past
   * where the capture stops, so a dialog opening there was invisible to the
   * snapshot and to the changes an action reports. Open shadow roots are
   * searched too, as the snapshot's walk enters them.
   */
  const floating = (): Element[] => {
    const roots = openRoots()
    const pick = (sel: string): Element[] => {
      const out: Element[] = []
      for (const r of roots) {
        try {
          // Not `push(...all)`: a big page's matches overflow the argument limit.
          for (const el of Array.from(r.querySelectorAll(sel))) out.push(el)
        } catch {
          return [] // a selector this engine does not know (`:popover-open`)
        }
      }
      return out
    }
    // Memoized per element, so a page of in-flow statuses costs one style
    // read per element on their shared ancestry rather than per candidate.
    const layered = new Map<Element, boolean>()
    const inLayer = (el: Element): boolean => {
      const seen: Element[] = []
      let hit = false
      for (let n: Element | null = el; n && n !== document.body && n !== document.documentElement; n = up(n)) {
        const known = layered.get(n)
        if (known !== undefined) {
          hit = known
          break
        }
        seen.push(n)
        const p = styleOf(n).position
        if (p === 'fixed' || p === 'absolute') {
          hit = true
          break
        }
      }
      // Exact for every element walked: below a positioned one, all are layered;
      // a walk that reached the body without one found none above any of them.
      for (const n of seen) layered.set(n, hit)
      return hit
    }
    // Outermost only, decided as each is taken, so the cap counts what is
    // lifted: neither in-flow statuses ahead of a toast nor the regions inside
    // an open modal can use it up.
    const found: Element[] = []
    const take = (el: Element): void => {
      if (found.some((o) => contains(o, el))) return
      for (let i = found.length - 1; i >= 0; i--) if (contains(el, found[i])) found.splice(i, 1)
      found.push(el)
    }
    const top = new Set(pick(TOP_LAYER))
    for (const el of top) if (found.length < 50 && shownDeep(el)) take(el)
    for (const el of pick(MAYBE_FLOATING)) {
      if (found.length >= 50) break
      if (top.has(el) || found.some((o) => contains(o, el))) continue
      if (inLayer(el) && shownDeep(el)) take(el)
    }
    return found
  }

  const snapshot = (args: { maxLines?: number; maxChars?: number }): unknown => {
    prune()
    const maxLines = args.maxLines || 500
    const maxChars = args.maxChars || 16000
    const lines: string[] = []
    let total = 0
    // The walk stops at the output cap rather than counting what it drops:
    // each element past it still cost a computed style, a rect and its text,
    // which on a long page was most of the snapshot's time. Elements visited
    // are capped too, for a page that is huge and mostly hidden.
    let full = false
    let visited = 0
    const push = (depth: number, s: string): void => {
      const line = '  '.repeat(depth) + '- ' + s
      if (lines.length >= maxLines || total + line.length > maxChars) {
        full = true
        return
      }
      lines.push(line)
      total += line.length + 1
    }

    const walk = (node: Element | ShadowRoot, depth: number): void => {
      const kids = Array.from((node as Element).children || [])
      for (const el of kids) visit(el, depth)
      if (node instanceof Element && node.shadowRoot) {
        for (const el of Array.from(node.shadowRoot.children)) visit(el, depth)
      }
    }

    const lifted = new Set<Element>()
    let lifting: Element | null = null
    const visit = (el: Element, depth: number): void => {
      if (full) return
      if (lifted.has(el) && el !== lifting) return
      if (++visited > 30000) {
        full = true
        return
      }
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head' || tag === 'svg' && !el.getAttribute('aria-label')) return
      if (isHidden(el)) return
      const role = roleOf(el)
      if (role && INTERACTIVE.has(role)) {
        if (!hasBox(el)) return
        const name = nameOf(el, role)
        const parts = [role + (name ? ' ' + JSON.stringify(cap(name, 100)) : ''), '[ref=' + refFor(el) + ']']
        parts.push(...attrsOf(el, role))
        const st = statesOf(el, role)
        if (st.length) parts.push('[' + st.join(', ') + ']')
        if (!inViewport(el)) parts.push('(offscreen)')
        push(depth, parts.join(' '))
        // A select's options are already on its line; a button's text is its name.
        if (role === 'combobox' || role === 'listbox' && tag === 'select') return
        if (role !== 'clickable' && role !== 'listbox' && role !== 'tab' && role !== 'menuitem') {
          // Interactive descendants of a link or button (a nested button in a
          // card link) still need their own refs.
          const nested = el.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [tabindex]')
          if (nested.length) walk(el, depth + 1)
          return
        }
        walk(el, depth + 1)
        return
      }
      if (role === 'heading') {
        const name = nameOf(el, role)
        if (name) push(depth, 'heading ' + JSON.stringify(cap(name, 120)) + ' [ref=' + refFor(el) + '] ' + attrsOf(el, role).join(' ') + (inViewport(el) ? '' : ' (offscreen)'))
        return
      }
      if (role === 'img') {
        push(depth, 'img ' + JSON.stringify(cap(nameOf(el, role), 100)))
        return
      }
      if (role === 'iframe') {
        push(depth, 'iframe' + (el.getAttribute('title') ? ' ' + JSON.stringify(el.getAttribute('title')) : '') + ' src=' + JSON.stringify(cap(el.getAttribute('src') || '', 80)))
        return
      }
      if (role && CONTAINERS.has(role)) {
        const before = lines.length
        const name = nameOf(el, role)
        const label = role + (name && role !== 'listitem' && role !== 'list' && role !== 'row' ? ' ' + JSON.stringify(cap(name, 60)) : '')
        // A list item that is only text reads better on one line.
        if (role === 'listitem' && !el.querySelector('a[href], button, input, select, textarea, [role], [tabindex]')) {
          const t = norm((el as HTMLElement).innerText)
          if (t) push(depth, 'listitem: ' + JSON.stringify(cap(t, 160)))
          return
        }
        push(depth, label + ':')
        const at = lines.length
        walk(el, depth + 1)
        if (lines.length === at && lines.length > before) {
          lines.pop()
          total -= label.length + 4 + depth * 2
        }
        return
      }
      if (el.children.length && onlyPhrasing(el)) {
        const whole = norm((el as HTMLElement).innerText)
        if (whole && hasBox(el)) push(depth, 'text: ' + JSON.stringify(cap(whole, 300)))
        return
      }
      const t = ownText(el)
      if (t && t.length > 1 && hasBox(el)) push(depth, 'text: ' + JSON.stringify(cap(t, 200)))
      walk(el, depth)
    }

    // Floating content first, so the budget reaches it on any page. Its lines
    // are the head of the tree (`head`), read whole whenever the capture is
    // longer than them — which is what lets a change there be exact.
    const over = floating()
    for (const el of over) lifted.add(el)
    for (const el of over) {
      lifting = el
      const at = lines.length
      push(0, 'floating:')
      visit(el, 1)
      if (lines.length === at + 1) {
        lines.pop()
        total -= 12
      }
    }
    lifting = null
    const head = lines.length
    if (document.body) walk(document.body, 0)
    const doc = document.scrollingElement || document.documentElement
    const active = deepActive()
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight },
      focused: active && active !== document.body ? describe(active) : null,
      tree: lines.join('\n'),
      truncated: full,
      head
    }
  }

  /**
   * Whether an ancestor makes `el` inert, across shadow boundaries — a host's
   * `inert` reaches into its shadow tree, which `closest()` cannot see.
   */
  const inertFrom = (el: Element): boolean => {
    let n: Element | null = el
    while (n) {
      if (n.hasAttribute('inert')) return true
      n = n.parentElement || (((n.getRootNode() as ShadowRoot).host as Element | undefined) ?? null)
    }
    return false
  }

  /** Whether focus is on `el` (or inside it, through shadow roots). */
  const hasFocus = (el: Element): boolean => {
    const a = deepActive()
    return !!a && contains(el, a)
  }

  const contains = (outer: Element, inner: Element | null): boolean => {
    let n: Node | null = inner
    while (n) {
      if (n === outer) return true
      n = (n as Element).parentElement || ((n.getRootNode() as ShadowRoot).host ?? null)
      if (n === document) return false
    }
    return false
  }

  const findByText = (text: string): Element | null => {
    const want = norm(text).toLowerCase()
    if (!want) return null
    let exact: Element | null = null
    let partial: Element | null = null
    let textExact: Element | null = null
    // Document order, then each shadow root's: a host's content after the light
    // DOM. Root by root, never one combined array spread into `push`, which a
    // page of 200k elements overflows before the search begins.
    for (const root of openRoots()) for (const el of Array.from(root.querySelectorAll('*'))) {
      if (isHidden(el) || !hasBox(el)) continue
      const role = roleOf(el)
      if (role && INTERACTIVE.has(role)) {
        const n = nameOf(el, role).toLowerCase()
        if (n === want && !exact) exact = el
        else if (!partial && n.includes(want)) partial = el
      } else if (!textExact && ownText(el).toLowerCase() === want) {
        textExact = el
      }
    }
    return exact || partial || textExact
  }

  type Target = { ref?: string; selector?: string; text?: string; focused?: boolean }
  const resolve = (t: Target): { el: Element } | { error: string } => {
    if (t.focused) {
      const el = deepActive()
      return el && el !== document.body ? { el } : { error: 'Nothing is focused.' }
    }
    if (t.ref) {
      const r = t.ref
      if (r.split(':')[0] !== doc) {
        return { error: 'That ref is from a page that has since been replaced (a navigation or reload) — take a new preview_snapshot.' }
      }
      const el = byRef.get(r)?.deref()
      if (!el || !el.isConnected) return { error: 'That ref is no longer on the page — take a new preview_snapshot.' }
      return { el }
    }
    if (t.selector) {
      let el: Element | null = null
      try {
        el = queryDeep(t.selector)
      } catch (e) {
        return { error: 'Invalid selector: ' + String((e as Error).message || e) }
      }
      return el ? { el } : { error: 'No element matches selector ' + JSON.stringify(t.selector) + '.' }
    }
    if (t.text) {
      const el = findByText(t.text)
      return el ? { el } : { error: 'No visible element with text ' + JSON.stringify(t.text) + '.' }
    }
    return { error: 'Name a target: ref (from preview_snapshot), selector, or text.' }
  }

  /** Where an element sits in the viewport, for the pane to draw the agent's mark on it. */
  const boxOf = (el: Element): { x: number; y: number; w: number; h: number; vw: number; vh: number } => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
  }

  /** Scrolls the target into view and returns the point a real click would land on. */
  const point = (t: Target): unknown => {
    const found = resolve(t)
    if ('error' in found) return found
    const el = found.el
    if (isHidden(el)) return { error: describe(el) + ' is hidden.' }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { error: describe(el) + ' has no size on screen.' }
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    // Through open shadow roots: the document reports a shadow host, and the
    // target may be inside it.
    let hit = document.elementFromPoint(x, y)
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    // The hit must be the target or inside it. An *ancestor* hit means the
    // point lands on what holds it — a clipped button, `pointer-events: none`
    // — and a real click there would go to the background.
    const ok = !!hit && contains(el, hit)
    return {
      x,
      y,
      vw: innerWidth,
      vh: innerHeight,
      desc: describe(el),
      ref: refFor(el),
      obscuredBy: ok ? undefined : describe(hit)
    }
  }

  /**
   * Focuses a field for typing and, unless appending, selects what is in it so
   * the text that follows replaces it — `fill` semantics, which is what "type
   * x into the search box" means. A `<select>` is chosen by option text or
   * value instead, since typing into one does nothing reliable.
   */
  const prepareType = (t: Target & { append?: boolean; text: string }): unknown => {
    let el: Element | null = null
    if (t.ref || t.selector || (t as any).target_text) {
      const found = resolve({ ref: t.ref, selector: t.selector, text: (t as any).target_text })
      if ('error' in found) return found
      el = found.el
    } else {
      el = (() => { const a = deepActive(); return a && a !== document.body ? a : null })()
      if (!el) return { error: 'Nothing is focused — name the field with ref or selector.' }
    }
    const tag = el.tagName.toLowerCase()
    // The same bar a person faces, before anything changes: a disabled, hidden
    // or inert control is not available to set.
    if (isHidden(el) || !hasBox(el)) return { error: describe(el) + ' is not visible.' }
    if (el.matches(':disabled') || inertFrom(el)) return { error: describe(el) + ' is disabled.' }
    if (tag === 'select') {
      const s = el as HTMLSelectElement
      const want = norm(t.text).toLowerCase()
      const usable = Array.from(s.options).filter((o) => !o.disabled && !(o.parentElement as HTMLOptGroupElement | null)?.disabled)
      const opt = usable.find((o) => norm(o.text).toLowerCase() === want || o.value.toLowerCase() === want) ||
        usable.find((o) => norm(o.text).toLowerCase().includes(want))
      if (!opt) return { error: 'No option ' + JSON.stringify(t.text) + ' in ' + describe(el) + '.' }
      s.value = opt.value
      s.dispatchEvent(new Event('input', { bubbles: true }))
      s.dispatchEvent(new Event('change', { bubbles: true }))
      return { selected: norm(opt.text), desc: describe(el), box: boxOf(el) }
    }
    const editable = tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
    if (!editable) return { error: describe(el) + ' is not a text field.' }
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return { error: describe(el) + ' is disabled or read-only.' }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
    ;(el as HTMLElement).focus()
    if (!hasFocus(el)) return { error: 'Could not focus ' + describe(el) + ' — it is hidden, inert or not focusable.' }
    if ((el as HTMLElement).isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      if (t.append) range.collapse(false)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    } else {
      const input = el as HTMLInputElement
      try {
        const end = input.value.length
        if (t.append) input.setSelectionRange(end, end)
        else input.setSelectionRange(0, end)
      } catch {
        // email/number inputs refuse a selection range; select() still works.
        if (!t.append) input.select()
      }
    }
    return { desc: describe(el), ref: refFor(el), box: boxOf(el) }
  }

  /**
   * Types into the field `prepareType` focused and selected, without the
   * guest holding the window's keyboard focus: the browser's own editing
   * command, which fires the same trusted `beforeinput`/`input` a keystroke
   * does and replaces the selection, so fill semantics hold. Used while Carbon
   * is in the background, where giving the guest focus would bring the app to
   * the front (`preview.ts`).
   */
  const insertText = (a: { ref: string; text: string; append?: boolean }): unknown => {
    const el = byRef.get(a.ref)?.deref() as HTMLElement | undefined
    if (!el || !el.isConnected) return { error: 'The field is gone.' }
    if (deepActive() !== el) el.focus()
    const ok = a.text ? document.execCommand('insertText', false, a.text) : document.execCommand('delete')
    if (ok) return { ok: true }
    // A field the command will not edit: set the value the way a framework's
    // own input handling expects to see it change.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      set?.call(el, a.append ? el.value + a.text : a.text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }
    return { error: 'Could not type into ' + describe(el) + '.' }
  }

  /**
   * Where keys aimed at an element (or the focused one) would go, for giving
   * the guest the keyboard in the background: a text field can be clicked
   * into, as a person would before pressing a key, and its selection put
   * back after; anything else cannot be clicked without acting on it.
   */
  const keyTarget = (a: { ref?: string }): unknown => {
    const el = (a.ref ? byRef.get(a.ref)?.deref() : deepActive()) as HTMLElement | null | undefined
    if (!el || el === document.body || !el.isConnected) return { textual: false }
    const tag = el.tagName.toLowerCase()
    const textual =
      tag === 'textarea' ||
      el.isContentEditable ||
      (tag === 'input' && !/^(button|submit|reset|checkbox|radio|file|image|color|range|hidden)$/i.test((el as HTMLInputElement).type))
    if (!textual) return { textual: false }
    const f = el as HTMLInputElement
    let start: number | null = null
    let end: number | null = null
    try {
      start = f.selectionStart
      end = f.selectionEnd
    } catch {
      // email/number inputs report no selection
    }
    return { textual: true, ref: refFor(el), start, end }
  }

  /** Puts a field's focus and selection back after the click that gave the guest the keyboard. */
  const restoreSelection = (a: { ref: string; start: number | null; end: number | null }): unknown => {
    const el = byRef.get(a.ref)?.deref() as HTMLInputElement | undefined
    if (!el) return false
    el.focus()
    if (a.start !== null && a.end !== null) {
      try {
        el.setSelectionRange(a.start, a.end)
      } catch {
        // no selection API on this type
      }
    }
    return true
  }

  /**
   * A key as page events, for the background when there is no field to click
   * into. Untrusted, so the page's own key handlers see it but the browser
   * does nothing with it; the two default actions agents rely on — Enter
   * submitting a form or activating a button, Space activating one — are done
   * here instead.
   */
  const syntheticKey = (a: {
    ref?: string
    key: string
    code: string
    keyCode: number
    alt: boolean
    ctrl: boolean
    meta: boolean
    shift: boolean
  }): unknown => {
    const el = ((a.ref ? byRef.get(a.ref)?.deref() : deepActive()) as HTMLElement | null | undefined) ?? document.body
    const init = {
      key: a.key,
      code: a.code,
      keyCode: a.keyCode,
      which: a.keyCode,
      altKey: a.alt,
      ctrlKey: a.ctrl,
      metaKey: a.meta,
      shiftKey: a.shift,
      bubbles: true,
      cancelable: true,
      composed: true
    }
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init))
    if (go && !a.alt && !a.ctrl && !a.meta) {
      const tag = el.tagName.toLowerCase()
      const type = (el as HTMLInputElement).type
      const role = el.getAttribute('role')
      const activates = tag === 'button' || role === 'button' || ((tag === 'a' || role === 'link') && a.key === 'Enter')
      if (a.key === 'Enter' && tag === 'input' && (el as HTMLInputElement).form) (el as HTMLInputElement).form!.requestSubmit()
      else if ((a.key === 'Enter' || a.key === ' ') && activates) el.click()
      else if (a.key === ' ' && tag === 'input' && (type === 'checkbox' || type === 'radio')) el.click()
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init))
    return { desc: describe(el) }
  }

  /** The value a field holds after typing, to confirm what landed. */
  const valueOf = (ref: string): unknown => {
    const el = byRef.get(ref)?.deref() as HTMLInputElement | undefined
    if (!el) return null
    if (el.isContentEditable) return norm(el.innerText)
    // Masked the way the snapshot masks it: a confirmation must not become a
    // way to read a password the user typed.
    if ((el.type || '').toLowerCase() === 'password') return el.value ? '••••' : ''
    return el.value
  }

  const present = (t: { ref?: string; text?: string; selector?: string }): boolean => {
    if (t.ref) {
      if (t.ref.split(':')[0] !== doc) return false
      const el = byRef.get(t.ref)?.deref()
      return !!el && el.isConnected && !isHidden(el) && hasBox(el)
    }
    if (t.selector) {
      // An invalid selector throws out to the caller: read as "absent", it
      // made `wait_for(gone)` succeed at once on a typo.
      const el = queryDeep(t.selector)
      return !!el && !isHidden(el) && hasBox(el)
    }
    if (t.text) {
      const want = norm(t.text).toLowerCase()
      const body = document.body ? (document.body as HTMLElement).innerText : ''
      if (norm(body).toLowerCase().includes(want)) return true
      // A host's `innerText` leaves its shadow tree out; read each root's own,
      // only where it is shown: a hidden component's text must not satisfy a
      // wait, nor keep a `gone` wait waiting. `innerText` of an unrendered
      // element is its `textContent`, hence the visibility check first.
      for (const r of openRoots().slice(1)) {
        for (const c of Array.from(r.children)) {
          if (!shownDeep(c)) continue
          const t = (c as HTMLElement).innerText
          if (typeof t === 'string' && norm(t).toLowerCase().includes(want)) return true
        }
      }
      return false
    }
    return false
  }

  const scrollState = (): unknown => {
    const doc = document.scrollingElement || document.documentElement
    return { y: Math.round(doc.scrollTop), x: Math.round(doc.scrollLeft), height: doc.scrollHeight, viewport: innerHeight }
  }

  const scrollTo = (where: 'top' | 'bottom'): unknown => {
    const doc = document.scrollingElement || document.documentElement
    doc.scrollTo({ top: where === 'top' ? 0 : doc.scrollHeight, behavior: 'instant' as ScrollBehavior })
    return scrollState()
  }

  /** JSON-safe copy of an evaluate result: nodes as markup, cycles and depth cut. */
  const serialize = (value: unknown): unknown => {
    const seen = new WeakSet<object>()
    const walk = (v: unknown, depth: number): unknown => {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'function') return '[Function ' + ((v as Function).name || 'anonymous') + ']'
        if (typeof v === 'bigint') return v.toString() + 'n'
        if (typeof v === 'symbol') return v.toString()
        if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
        return v
      }
      if (v instanceof Element) return cap((v as Element).outerHTML, 600)
      if (v instanceof Node) return '[' + v.nodeName + ']'
      if (seen.has(v as object)) return '[Circular]'
      seen.add(v as object)
      if (depth > 6) return Array.isArray(v) ? '[Array]' : '[Object]'
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (v instanceof Map) return { '[Map]': Array.from(v.entries()).slice(0, 100).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]) }
      if (v instanceof Set) return { '[Set]': Array.from(v).slice(0, 100).map((x) => walk(x, depth + 1)) }
      if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1))
      const out: Record<string, unknown> = {}
      let n = 0
      for (const k in v as object) {
        if (n++ >= 200) {
          out['…'] = 'truncated'
          break
        }
        try {
          out[k] = walk((v as any)[k], depth + 1)
        } catch (e) {
          out[k] = '[Threw ' + String(e) + ']'
        }
      }
      return out
    }
    return walk(value, 0)
  }

  /** Focuses a target before a key press, so the key goes where it was meant. */
  const focus = (t: Target): unknown => {
    const found = resolve(t)
    if ('error' in found) return found
    const el = found.el as HTMLElement
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
    el.focus()
    // Keys sent after a focus that did not take would go to whatever had
    // focus before — Enter on a disabled button submitting another form.
    if (!hasFocus(el)) return { error: 'Could not focus ' + describe(el) + ' — it is disabled, hidden or not focusable.' }
    return { desc: describe(el), ref: refFor(el), box: boxOf(el) }
  }

  /** Of these refs, the ones whose element is still connected and visible (`PreviewDriver.stillPresent`). */
  const presentRefs = (keys: string[]): string[] =>
    keys.filter((k) => {
      const el = byRef.get(k)?.deref()
      return !!el && el.isConnected && shownDeep(el)
    })

  const agent = { snapshot, presentRefs, point, prepareType, insertText, keyTarget, restoreSelection, syntheticKey, valueOf, present, scrollState, scrollTo, serialize, describe, focus }
  Object.defineProperty(w, '__carbonAgent', { value: agent, configurable: true })
  return agent
}

const RUNTIME_SOURCE = '(' + carbonAgentRuntime.toString() + ')()'

/** An expression calling one runtime method, installing the runtime first if this document has none. */
export function agentCall(method: string, args?: unknown): string {
  const arg = args === undefined ? '' : JSON.stringify(args)
  return `(window.__carbonAgent || ${RUNTIME_SOURCE}).${method}(${arg})`
}

/** The source of a function the driver passes to `Runtime.callFunctionOn` to serialize a result. */
export const SERIALIZE_FN = `function () { return (window.__carbonAgent || ${RUNTIME_SOURCE}).serialize(this) }`

/**
 * Whether an evaluate expression is a function to call rather than an
 * expression to read — `() => document.title` should run, not come back as
 * "[Function anonymous]".
 */
export function isFunctionSource(expression: string): boolean {
  const s = expression.trim()
  return /^(async\s+)?function\b/.test(s) || /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s)
}
