import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'

// Runs the panel page's classic script in a vm context over a minimal stub DOM (no dependencies).
// The stub knows only what the template touches: tags, classes, attributes, text, listeners, and simple selectors.
export const TEMPLATE_PATH = resolve(import.meta.dirname, '../../panel/template.html')

// A selector is a tag, classes and attribute tests, e.g. 'button.act[data-command]'.
function parseSelector(selector) {
  const m = selector.match(/^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/)
  if (!m) throw new Error(`unsupported selector ${selector}`)
  const classes = m[2] ? m[2].slice(1).split('.') : []
  const attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((a) => ({ name: a[1], value: a[2] }))
  return { tag: m[1] || null, classes, attrs }
}

function matches(node, sel) {
  if (sel.tag && node.tag !== sel.tag) return false
  if (!sel.classes.every((c) => node.classes.has(c))) return false
  return sel.attrs.every((a) => (a.value === undefined ? node.attrs.has(a.name) : node.attrs.get(a.name) === a.value))
}

function makeElement(tag, doc) {
  const node = {
    tag,
    attrs: new Map(),
    classes: new Set(),
    children: [],
    parent: null,
    listeners: {},
    text: '',
    disabled: false,
    style: {},
    tabIndex: -1,
    doc,
    getAttribute: (name) => (node.attrs.has(name) ? node.attrs.get(name) : null),
    setAttribute: (name, value) => node.attrs.set(name, String(value)),
    addEventListener: (type, fn) => { (node.listeners[type] ||= []).push(fn) },
    closest(selector) {
      const sel = parseSelector(selector)
      for (let n = node; n; n = n.parent) if (matches(n, sel)) return n
      return null
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null },
    querySelectorAll(selector) {
      const sel = parseSelector(selector)
      const out = []
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c) } }
      walk(node)
      return out
    },
    appendChild(child) { child.parent = node; node.children.push(child); return child },
    insertAdjacentElement(where, el) {
      if (where !== 'afterend' || !node.parent) return null
      const i = node.parent.children.indexOf(node)
      el.parent = node.parent
      node.parent.children.splice(i + 1, 0, el)
      return el
    },
    remove() {
      if (!node.parent) return
      node.parent.children = node.parent.children.filter((c) => c !== node)
      node.parent = null
    },
    selectAllChildren() {},
    get className() { return [...node.classes].join(' ') },
    set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)) },
    get textContent() { return node.text },
    set textContent(value) { node.text = String(value) },
    get innerHTML() { return '' },
    set innerHTML(value) { node.html = String(value) },
    classList: {
      contains: (c) => node.classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !node.classes.has(c) : !!force
        if (on) node.classes.add(c); else node.classes.delete(c)
        return on
      },
      add: (...cs) => cs.forEach((c) => node.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => node.classes.delete(c)),
    },
  }
  return node
}

// A card for the page: its buttons carry the data the template reads. Each button is { kind, command, params, text, label }.
function buildCard(doc, card) {
  const section = doc.createElement('section')
  section.classList.add('host')
  section.setAttribute('data-host', card.name)
  section.setAttribute('data-view', 'session')
  section.setAttribute('data-face', 'list')
  const msg = doc.createElement('p')
  msg.classList.add('msg')
  section.appendChild(msg)
  for (const b of card.buttons ?? []) {
    const button = doc.createElement('button')
    button.classList.add('act', `act-${b.kind}`)
    button.setAttribute('data-host', card.name)
    button.setAttribute('data-text', b.text ?? '')
    button.setAttribute('data-command', b.command)
    button.setAttribute('data-params', JSON.stringify(b.params ?? {}))
    button.textContent = b.label ?? b.kind
    section.appendChild(button)
  }
  return section
}

// Loads the page with the given data: { generatedAt, target, cards: [{ name, buttons }] }, or no cards for the placeholder.
// transport 'post' gives the page the older postMessage bridge; 'frame' gives it window.orca.host.call (Orca 1.4.245+).
// Results are given as the host reports them: { ok: true, value } or { ok: false, errorCode, error }. The frame
// transport resolves with the value, or rejects with an error that carries code and message.
// Returns: calls (what the page asked for), respond(index, result), fireTimers(ms), click(button), cardOf(name),
// buttonOf(name, kind), stamp, and flush() to let the page's promise callbacks run.
export async function loadPage({ generatedAt = null, cards = [], html = null, transport = 'post' } = {}) {
  const source = html ?? await readFile(TEMPLATE_PATH, 'utf8')
  const script = source.slice(source.indexOf('<script>') + '<script>'.length, source.indexOf('</script>'))
  const doc = {
    listeners: {},
    createElement: (tag) => makeElement(tag, doc),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener: (type, fn) => { (doc.listeners[type] ||= []).push(fn) },
    querySelector: (selector) => doc.body.querySelector(selector),
    querySelectorAll: (selector) => doc.body.querySelectorAll(selector),
    getElementById: (id) => doc.body.querySelectorAll(`[id="${id}"]`)[0] ?? null,
  }
  doc.body = makeElement('body', doc)
  const stamp = makeElement('footer', doc)
  stamp.setAttribute('id', 'stamp')
  doc.body.appendChild(stamp)
  doc.body.appendChild(makeElement('div', doc)).classList.add('tip')
  const main = doc.body.appendChild(makeElement('main', doc))
  for (const card of cards) main.appendChild(buildCard(doc, card))

  const calls = []
  const messageListeners = []
  const frameWaiters = []
  const timers = []
  // The page's objects live in the vm's realm; a JSON copy makes them plain host objects for the assertions.
  const copy = (value) => JSON.parse(JSON.stringify(value))
  const win = {
    parent: { postMessage: (message) => calls.push(copy(message)) },
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn) },
    getSelection: () => null,
    innerWidth: 400,
    innerHeight: 800,
  }
  if (transport === 'frame') {
    win.orca = {
      host: Object.freeze({
        call: (method, params) => new Promise((resolve, reject) => {
          calls.push({ action: method, params: copy(params) })
          frameWaiters[calls.length - 1] = { resolve, reject }
        }),
        has: () => true,
      }),
    }
  }
  const data = { generatedAt, target: cards[0]?.name ?? null, hosts: {} }
  const sandbox = {
    window: win,
    document: doc,
    console,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Promise,
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t },
    clearTimeout: (t) => { if (t) t.done = true },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(script.replace('/*__DATA__*/', () => JSON.stringify(data)), sandbox, { filename: 'panel.js' })

  const flush = () => new Promise((resolveTick) => setImmediate(resolveTick))
  return {
    calls,
    stamp,
    main,
    async respond(index, result) {
      if (transport === 'frame') {
        const waiter = frameWaiters[index]
        if (result.ok) waiter.resolve(copy(result.value))
        else waiter.reject(Object.assign(new Error(result.error), { code: result.errorCode }))
      } else {
        const request = calls[index]
        for (const fn of messageListeners) fn({ source: win.parent, data: { type: 'orca-panel-action-result', requestId: request.requestId, ...result } })
      }
      await flush()
    },
    // Runs the pending timers of at least ms: a page call's timeout fires after its own length.
    async fireTimers(ms) {
      for (const t of timers.filter((x) => !x.done && x.ms === ms)) { t.done = true; t.fn() }
      await flush()
    },
    async click(button) {
      for (const fn of button.listeners.click ?? []) fn()
      await flush()
    },
    flush,
    cardOf: (name) => doc.body.querySelectorAll('section.host').find((s) => s.getAttribute('data-host') === name),
    buttonOf: (name, kind) => doc.body.querySelectorAll(`button.act-${kind}`).find((b) => b.closest('section.host')?.getAttribute('data-host') === name) ?? null,
  }
}
