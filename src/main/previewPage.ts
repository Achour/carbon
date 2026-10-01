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

  const refOf = new WeakMap<Element, string>()
  const byRef = new Map<string, WeakRef<Element>>()
  let nextRef = 1
  const refFor = (el: Element): string => {
    let r = refOf.get(el)
    if (!r) {
      r = 'e' + nextRef++
      refOf.set(el, r)
    }
    byRef.set(r, new WeakRef(el))
    return r
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
    if (document.activeElement === el) out.push('focused')
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

  const snapshot = (args: { maxLines?: number; maxChars?: number }): unknown => {
    const maxLines = args.maxLines || 500
    const maxChars = args.maxChars || 16000
    const lines: string[] = []
    let total = 0
    let dropped = 0
    const push = (depth: number, s: string): void => {
      const line = '  '.repeat(depth) + '- ' + s
      if (lines.length >= maxLines || total + line.length > maxChars) {
        dropped++
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

    const visit = (el: Element, depth: number): void => {
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

    if (document.body) walk(document.body, 0)
    const doc = document.scrollingElement || document.documentElement
    const active = document.activeElement
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight },
      focused: active && active !== document.body ? describe(active) : null,
      tree: lines.join('\n'),
      dropped
    }
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
    const all = Array.from(document.querySelectorAll('*'))
    let exact: Element | null = null
    let partial: Element | null = null
    let textExact: Element | null = null
    for (const el of all) {
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
      const el = document.activeElement
      return el && el !== document.body ? { el } : { error: 'Nothing is focused.' }
    }
    if (t.ref) {
      const r = t.ref.replace(/^\[?ref=/, '').replace(/\]$/, '')
      const el = byRef.get(r)?.deref()
      if (!el || !el.isConnected) return { error: 'ref ' + r + ' is no longer on the page — take a new preview_snapshot.' }
      return { el }
    }
    if (t.selector) {
      let el: Element | null = null
      try {
        el = document.querySelector(t.selector)
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
    const hit = document.elementFromPoint(x, y)
    const ok = !hit || contains(el, hit) || contains(hit, el)
    return {
      x,
      y,
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
      el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null
      if (!el) return { error: 'Nothing is focused — name the field with ref or selector.' }
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') {
      const s = el as HTMLSelectElement
      const want = norm(t.text).toLowerCase()
      const opt = Array.from(s.options).find((o) => norm(o.text).toLowerCase() === want || o.value.toLowerCase() === want) ||
        Array.from(s.options).find((o) => norm(o.text).toLowerCase().includes(want))
      if (!opt) return { error: 'No option ' + JSON.stringify(t.text) + ' in ' + describe(el) + '.' }
      s.value = opt.value
      s.dispatchEvent(new Event('input', { bubbles: true }))
      s.dispatchEvent(new Event('change', { bubbles: true }))
      return { selected: norm(opt.text), desc: describe(el) }
    }
    const editable = tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
    if (!editable) return { error: describe(el) + ' is not a text field.' }
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return { error: describe(el) + ' is disabled or read-only.' }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
    ;(el as HTMLElement).focus()
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
    return { desc: describe(el), ref: refFor(el) }
  }

  /** The value a field holds after typing, to confirm what landed. */
  const valueOf = (ref: string): unknown => {
    const el = byRef.get(ref)?.deref() as HTMLInputElement | undefined
    if (!el) return null
    return el.isContentEditable ? norm(el.innerText) : el.value
  }

  const present = (t: { text?: string; selector?: string }): boolean => {
    if (t.selector) {
      let el: Element | null = null
      try {
        el = document.querySelector(t.selector)
      } catch {
        return false
      }
      return !!el && !isHidden(el) && hasBox(el)
    }
    if (t.text) {
      const body = document.body ? (document.body as HTMLElement).innerText : ''
      return norm(body).toLowerCase().includes(norm(t.text).toLowerCase())
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
    return { desc: describe(el), ref: refFor(el) }
  }

  const agent = { snapshot, point, prepareType, valueOf, present, scrollState, scrollTo, serialize, describe, focus }
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
