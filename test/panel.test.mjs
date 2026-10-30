import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arcPath, ringSvg, renderCard, renderPanel, placeholderPanel, writePanel } from '../lib/panel.mjs'
import { buildPanelData } from '../lib/panel-data.mjs'

const TEMPLATE = '<main><!--__CARDS__--></main><script>const D = /*__DATA__*/;</script>'
const PAGE = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')

// The opening tag of the first element with this class, and its attributes as a map.
const tagOf = (svg, cls) => svg.match(new RegExp(`<[a-z]+ class="${cls}"[^>]*>`))?.[0]
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))

// Same shape as the panel-data fixture: a active, b parked and full, c spent on the session, d blocked.
const session = (remaining, resets = null) => [
  { kind: 'session', scope: null, group: 'session', remaining, resets_at: resets },
  { kind: 'weekly_all', scope: null, group: 'weekly', remaining: 80, resets_at: null },
]
const report = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c', 'd'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, snapshot: session(42.01) },
    { id: 'b', name: 'b', parked: true, blocked: null, snapshot: session(100) },
    { id: 'c', name: 'c', parked: true, blocked: null, snapshot: session(5, '2026-10-24T13:00:00+02:00') },
    { id: 'd', name: 'd', parked: true, blocked: 'authentication_failed', snapshot: null },
  ],
})

// mac is the target and reachable; devbox is unreachable.
function panelOf(value) {
  const settings = { hosts: [{ name: 'mac' }, { name: 'devbox' }], target: 'mac' }
  return buildPanelData({
    settings,
    now: new Date(0),
    timeZone: 'Europe/Zurich',
    hosts: [
      { host: settings.hosts[0], result: { ok: true, value } },
      { host: settings.hosts[1], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } },
    ],
  })
}

test('arcPath starts at 12 o\'clock and sweeps clockwise', () => {
  assert.equal(arcPath(110, 110, 80, 0, 90), 'M 110 30 A 80 80 0 0 1 190 110')
})

test('ringSvg draws n base arcs, one fill arc for the active segment sized by remaining, n badges', () => {
  const view = panelOf(report()).hosts[0].views.session
  const svg = ringSvg(view)
  assert.ok(svg.startsWith('<svg viewBox="0 0 220 220">'))
  assert.equal((svg.match(/class="seg /g) ?? []).length, 4)
  assert.equal((svg.match(/class="fill fill-/g) ?? []).length, 1)
  assert.equal((svg.match(/class="badge"/g) ?? []).length, 4)
  // each segment spans 86 degrees from a 2 degree half gap; the remaining arc runs from the needle to the slice end
  assert.ok(svg.includes(arcPath(110, 110, 80, 2 + 86 * (1 - 0.4201), 88)))
  assert.ok(svg.includes('seg-active') && svg.includes('seg-next') && svg.includes('seg-spent') && svg.includes('seg-blocked'))
  assert.ok(svg.includes('42% left'))
})

test('ringSvg with no segments draws an empty ring with the centre text only', () => {
  const svg = ringSvg({ centre: { name: '—', percentText: '—', hint: 'no active login', next: 'next ▸ none' }, rows: [], segments: [] })
  assert.equal(svg.includes('class="seg'), false)
  assert.equal(svg.includes('class="badge"'), false)
  assert.ok(svg.includes('no active login'))
})

test('renderCard escapes a name like o\'brien $x in text and in data-text', () => {
  const data = report()
  data.order.push("o'brien $x")
  data.accounts.push({ id: 'q', name: "o'brien $x", parked: true, blocked: null, snapshot: null })
  const commands = { mac: { refresh: 'R', enrol: 'E', swap: 'S', swapTo: { "o'brien $x": "swap o'brien" } } }
  const [mac] = panelOf(data).hosts
  const html = renderCard({ ...mac, open: true }, commands)
  assert.ok(html.includes('<span class="row-name">o\'brien $x</span>'))
  assert.ok(html.includes('data-text="swap o&#39;brien"'))
  assert.equal(html.includes("swap o'brien"), false)
})

test('renderCard marks the target open and wraps other hosts in details', () => {
  const [mac, dev] = panelOf(report()).hosts
  const open = renderCard({ ...mac, open: true }, {})
  assert.ok(open.startsWith('<section class="host" data-host="mac"'))
  const closed = renderCard({ ...dev, open: false }, {})
  assert.ok(closed.startsWith('<details'))
  assert.ok(closed.includes('<section'))
})

test('renderCard gives an active blocked row the re-authenticate button', () => {
  const data = report()
  data.active = { id: 'd', name: 'd', enrolled: true, in_order: true }
  const [mac] = panelOf(data).hosts
  const html = renderCard({ ...mac, open: true }, { mac: { refresh: 'R', enrol: 'E', swap: 'S', swapTo: {} } })
  assert.ok(html.includes('active · blocked: authentication_failed'))
  // Each view renders the row, and the view CSS shows only one of them, so there is one button per view. The list face's cards come after the views.
  assert.equal(html.split('<div class="list">')[0].split('act-reauth').length - 1, 2)
})

test('renderCard for an unreachable host shows the chip and detail and no ring', () => {
  const [, dev] = panelOf(report()).hosts
  const html = renderCard({ ...dev, open: false }, { 'devbox': { refresh: 'R', enrol: 'E', swap: 'S', swapTo: {} } })
  assert.ok(html.includes('chip-unreachable'))
  assert.ok(html.includes('Connection refused'))
  assert.equal(html.includes('<svg'), false)
  assert.ok(html.includes('act-refresh'))
  assert.equal(html.includes('act-swap'), false)
})

test('renderPanel replaces both markers and the result is under 256 KiB', () => {
  const commands = { mac: { refresh: 'R', enrol: 'E', swap: 'S', swapTo: { b: 'swap b' } } }
  const html = renderPanel(panelOf(report()), { template: TEMPLATE, commands })
  assert.equal(html.includes('<!--__CARDS__-->'), false)
  assert.equal(html.includes('/*__DATA__*/'), false)
  assert.ok(html.includes('"target":"mac"'))
  assert.equal(html.split('<details').length - 1, 1)
  assert.ok(Buffer.byteLength(html) < 256 * 1024)
})

test('renderPanel JSON data cannot close the script tag', () => {
  const settings = { hosts: [{ name: '</script><b>' }], target: '</script><b>' }
  const data = buildPanelData({
    settings,
    now: new Date(0),
    hosts: [{ host: settings.hosts[0], result: { ok: true, value: report() } }],
  })
  const html = renderPanel(data, { template: TEMPLATE })
  assert.equal(html.split('</script>').length, 2)
  assert.ok(html.includes('\\u003c/script>'))
})

test('placeholderPanel mentions Grazr: Refresh panel and says installed copies never write', () => {
  const html = placeholderPanel(TEMPLATE)
  assert.ok(html.includes('Grazr: Refresh panel'))
  assert.ok(html.includes('Installed copies never write this page'))
  assert.ok(html.includes('development install'))
  assert.equal(html.includes('<!--__CARDS__-->'), false)
})

// dev: whether the root holds a .git entry, as a development checkout does.
function fakeFs({ write, rename, dev = true } = {}) {
  const files = new Map()
  const writes = []
  const failWith = (code) => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  return {
    files,
    writes,
    async stat(path) {
      if (dev && path.endsWith('/.git')) return { isFile: () => false }
      failWith('ENOENT')
    },
    async readFile(path) {
      if (files.has(path)) return files.get(path)
      failWith('ENOENT')
    },
    async mkdir() {},
    async writeFile(path, data) {
      if (write) failWith(write)
      writes.push(path)
      files.set(path, data)
    },
    async rename(from, to) {
      if (rename) failWith(rename)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async unlink(path) {
      if (!files.delete(path)) failWith('ENOENT')
    },
  }
}

test('writePanel writes through a temp file and leaves none behind', async () => {
  const fs = fakeFs()
  assert.equal(await writePanel({ root: '/state', html: '<p>a</p>', fs }), 'written')
  assert.equal(fs.files.get('/state/panel/accounts.html'), '<p>a</p>')
  assert.deepEqual([...fs.files.keys()], ['/state/panel/accounts.html'])
  assert.equal(await writePanel({ root: '/state', html: '<p>a</p>', fs }), 'unchanged')
  assert.equal(fs.writes.length, 1)
  assert.equal(await writePanel({ root: '/state', html: '<p>b</p>', fs }), 'written')
  assert.equal(fs.files.get('/state/panel/accounts.html'), '<p>b</p>')
  assert.deepEqual([...fs.files.keys()], ['/state/panel/accounts.html'])
})

test('writePanel never writes into an installed copy, even one that carries a .git entry', async () => {
  const installed = `/home/t/.orca/plugins/grazr/${'a'.repeat(64)}`
  const fs = fakeFs()
  assert.equal(await writePanel({ root: installed, html: '<p>a</p>', fs }), 'skipped')
  assert.equal(fs.files.size, 0)
  assert.equal(fs.writes.length, 0)
})

test('writePanel skips a root that is not a git checkout without touching the disk', async () => {
  const fs = fakeFs({ dev: false })
  assert.equal(await writePanel({ root: '/state', html: '<p>a</p>', fs }), 'skipped')
  assert.equal(fs.files.size, 0)
  assert.equal(fs.writes.length, 0)
})

test('isDevInstall is true for a checkout with a .git entry and false for a hash-named install', async () => {
  const { isDevInstall } = await import('../lib/panel.mjs')
  assert.equal(await isDevInstall('/state', fakeFs()), true)
  assert.equal(await isDevInstall('/state', fakeFs({ dev: false })), false)
  assert.equal(await isDevInstall(`/x/${'0'.repeat(64)}`, fakeFs()), false)
  // 64 characters that are not all lowercase hex are an ordinary directory name.
  assert.equal(await isDevInstall(`/x/${'A'.repeat(64)}`, fakeFs()), true)
})

test('writePanel skips read-only locations and leaves no temp file', async () => {
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    const readOnly = fakeFs({ write: code })
    assert.equal(await writePanel({ root: '/state', html: '<p>a</p>', fs: readOnly }), 'skipped')
    assert.equal(readOnly.files.size, 0)
  }
  const renameFails = fakeFs({ rename: 'EROFS' })
  assert.equal(await writePanel({ root: '/state', html: '<p>a</p>', fs: renameFails }), 'skipped')
  assert.equal(renameFails.files.size, 0)
})

test('arcPath clamps a full circle so it is never degenerate', () => {
  const full = arcPath(110, 110, 80, 0, 360)
  assert.equal(full, arcPath(110, 110, 80, 0, 359.9))
  assert.notEqual(full, 'M 110 30 A 80 80 0 0 1 110 30')
  assert.equal(full.split(' ')[7], '1')
  assert.equal(arcPath(110, 110, 80, 0, 0), arcPath(110, 110, 80, 0, 0.1))
})

// The visible text of a centre line, from its element's markup (the title is skipped).
const visibleOf = (svg, cls) => svg.match(new RegExp(`<text class="${cls}"[^>]*><title>[^<]*</title>([^<]*)</text>`))?.[1]

// The shown text of each centre line for the samples the review measured against the system font. The name's
// budget is the inner circle's chord at its glyph top less the margin (about 116 px at 12 px); the next name's is about 70 px.
test('ringSvg cuts a long centre name to the text the measured width table fits', () => {
  const svg = ringSvg({ centre: { name: 'a'.repeat(39) + 'Z', percentText: '1%', hint: 'fine', next: 'next ▸ none' }, rows: [], segments: [] })
  assert.equal(visibleOf(svg, 'centre-name'), `${'a'.repeat(14)}…`)
  assert.ok(svg.includes(`<title>${'a'.repeat(39)}Z</title>`))
})

test('ringSvg cuts an all-caps name shorter than the same length in lower case', () => {
  const caps = ringSvg({ centre: { name: 'A'.repeat(18), percentText: '1%', hint: 'fine' }, rows: [], segments: [] })
  const lower = ringSvg({ centre: { name: 'a'.repeat(18), percentText: '1%', hint: 'fine' }, rows: [], segments: [] })
  assert.equal(visibleOf(caps, 'centre-name'), `${'A'.repeat(11)}…`)
  assert.equal(visibleOf(lower, 'centre-name'), `${'a'.repeat(14)}…`)
})

test('ringSvg cuts M and W names to nine characters and a CJK name to eight, so the wide glyphs stay inside the stroke', () => {
  const shown = (name) => visibleOf(ringSvg({ centre: { name, percentText: '1%', hint: 'fine' }, rows: [], segments: [] }), 'centre-name')
  assert.equal(shown('M'.repeat(18)), `${'M'.repeat(9)}…`)
  assert.equal(shown('W'.repeat(18)), `${'W'.repeat(9)}…`)
  assert.equal(shown('中'.repeat(18)), `${'中'.repeat(8)}…`)
})

test('ringSvg keeps the live account email to its readable start, and cuts the email samples by width', () => {
  const svg = ringSvg({ centre: { name: 'alice@example.com', percentText: '1%', hint: 'fine', nextName: 'bob@example.com', tone: 'fine' }, rows: [], segments: [] })
  assert.equal(visibleOf(svg, 'centre-name'), 'alice@example.c…')
  assert.ok(svg.includes('<title>alice@example.com</title>'))
  assert.equal(visibleOf(svg, 'centre-next-name'), 'bob@examp…')
})

test('ringSvg cuts a 40-character block reason in the hint line to the text the width table fits', () => {
  const svg = ringSvg({ centre: { name: 'a', percentText: '1%', hint: 'Wm'.repeat(20), tone: 'blocked' }, rows: [], segments: [] })
  assert.equal(svg.match(/<text class="centre-hint"[^>]*>([^<]*)<\/text>/)[1], 'WmWmWmWmWm…')
})

test('ringSvg colours each segment by its account state, and the next segment is dashed', () => {
  const svg = ringSvg(panelOf(report()).hosts[0].views.session)
  assert.ok(svg.includes('class="seg seg-active"'))
  assert.ok(svg.includes('class="seg seg-spent"'))
  assert.ok(svg.includes('class="seg seg-blocked"'))
  const next = svg.match(/<path class="seg seg-next"[^>]*\/>/)?.[0]
  assert.ok(next, 'the next segment is drawn')
  assert.ok(next.includes('stroke-dasharray="'))
  assert.equal((svg.match(/stroke-dasharray/g) ?? []).length, 1)
})

test('ringSvg sets the centre percentage tone class and the next label as two lines', () => {
  const svg = ringSvg(panelOf(report()).hosts[0].views.session)
  assert.ok(svg.includes('class="centre-pct tone-fine"'))
  const name = attrsOf(tagOf(svg, 'centre-name'))
  assert.deepEqual([name.x, name.y, name['font-size']], ['110', '92', '12'])
  const pct = attrsOf(tagOf(svg, 'centre-pct tone-fine'))
  assert.deepEqual([pct.x, pct.y, pct['font-size']], ['110', '120', '20'])
  const hint = attrsOf(tagOf(svg, 'centre-hint'))
  assert.deepEqual([hint.y, hint['font-size']], ['140', '10'])
  // Next is b, the account after the active one; the arrow and the name are separate lines, both inside the ring.
  const arrow = attrsOf(tagOf(svg, 'centre-next'))
  const who = attrsOf(tagOf(svg, 'centre-next-name'))
  assert.deepEqual([arrow.y, arrow['font-size']], ['150', '10'])
  assert.deepEqual([who.y, who['font-size']], ['162', '10'])
  assert.ok(Number(arrow.y) <= 110 + 66 && Number(who.y) <= 110 + 66)
  assert.ok(svg.includes('>next ▸</text>'))
  assert.ok(svg.includes('<title>b</title>b</text>'))
})

test('ringSvg cuts a 30-character centre name and next name by width, both with the full name in a title', () => {
  const a = 'a'.repeat(30)
  const b = 'b'.repeat(30)
  const svg = ringSvg({ centre: { name: a, percentText: '1%', hint: 'fine', next: `next ▸ ${b}`, nextName: b, tone: 'fine' }, rows: [], segments: [] })
  const centreName = svg.match(/<text class="centre-name"[^>]*><title>([^<]*)<\/title>([^<]*)<\/text>/)
  assert.equal(centreName[1], a)
  assert.equal(centreName[2], `${'a'.repeat(14)}…`)
  const nextName = svg.match(/<text class="centre-next-name"[^>]*><title>([^<]*)<\/title>([^<]*)<\/text>/)
  assert.equal(nextName[1], b)
  assert.equal(nextName[2], `${'b'.repeat(10)}…`)
  // Baselines: name 92, hint 140, next lines 150 and 162, all within the ring.
  assert.equal(attrsOf(tagOf(svg, 'centre-name')).y, '92')
  assert.equal(attrsOf(tagOf(svg, 'centre-hint')).y, '140')
  assert.equal(attrsOf(tagOf(svg, 'centre-next')).y, '150')
  assert.equal(attrsOf(tagOf(svg, 'centre-next-name')).y, '162')
})

test('ringSvg escapes a next name and a hint that carry markup and quotes, in the text and in the title', () => {
  const raw = `<x>"'&`
  const svg = ringSvg({ centre: { name: 'a', percentText: '1%', hint: raw, nextName: raw, tone: 'fine' }, rows: [], segments: [] })
  assert.equal(svg.includes('<x>'), false)
  assert.ok(svg.includes(`<title>&lt;x&gt;"'&amp;</title>&lt;x&gt;"'&amp;</text>`))
  assert.ok(svg.includes(`class="centre-hint" x="110" y="140" font-size="10" text-anchor="middle">&lt;x&gt;"'&amp;</text>`))
})

test('ringSvg renders next none muted and a none tone in the foreground', () => {
  const svg = ringSvg({ centre: { name: 'a', percentText: '1%', hint: 'fine', next: 'next ▸ none', nextName: null, tone: 'none' }, rows: [], segments: [] })
  assert.ok(svg.includes('<text class="centre-next none"'))
  assert.ok(svg.includes('<text class="centre-next-name none"'))
  assert.ok(svg.includes('class="centre-pct tone-none"'))
})

test('ringSvg shows a warning tone in the amber class and a blocked tone in the destructive one', () => {
  const view = (tone) => ({ centre: { name: 'a', percentText: '10% left', hint: 'x', next: 'next ▸ none', nextName: null, tone }, rows: [], segments: [] })
  assert.ok(ringSvg(view('warning')).includes('class="centre-pct tone-warning"'))
  assert.ok(ringSvg(view('blocked')).includes('class="centre-pct tone-blocked"'))
  assert.ok(ringSvg(view('spent')).includes('class="centre-pct tone-spent"'))
})

test('the template defines the native ring colours, opacities and row colours', () => {
  const rules = [
    '.seg-active{stroke:var(--grazr-ok);stroke-opacity:.28}',
    '.seg-ok{stroke:var(--grazr-ok);stroke-opacity:.4}',
    '.seg-next{stroke:var(--grazr-next)}',
    '.seg-spent{stroke:var(--orca-destructive, var(--destructive,#f87171));stroke-opacity:.6}',
    '.seg-blocked{stroke:var(--orca-destructive, var(--destructive,#f87171))}',
    '.seg-unknown{stroke:var(--orca-muted-foreground, var(--muted-foreground,#999));stroke-opacity:.2}',
    '.tone-fine{fill:var(--grazr-ok)}',
    '.tone-warning{fill:var(--grazr-warn)}',
    '.tone-spent,.tone-blocked{fill:var(--orca-destructive, var(--destructive,#f87171))}',
    '.centre-next,.centre-next-name{fill:var(--grazr-next)}',
    '.centre-next.none,.centre-next-name.none{fill:var(--orca-muted-foreground, var(--muted-foreground,#999))}',
    '.row-active .row-name{color:var(--grazr-ok)}',
    '.row-next .row-name::before{background:var(--grazr-next)}',
    '.row-blocked .row-name::before{background:var(--orca-destructive, var(--destructive,#f87171))}',
  ]
  for (const rule of rules) assert.ok(PAGE.includes(rule), `missing ${rule}`)
  assert.ok(PAGE.includes('--grazr-warn: #fbbf24;') || PAGE.includes('--grazr-warn:#fbbf24;'))
})

test('no spent row rule sets a text colour, so a spent row keeps its name colour', () => {
  const rules = [...PAGE.matchAll(/([^{}]*\.row-spent[^{}]*)\{([^}]*)\}/g)]
  assert.ok(rules.length > 0, 'the template styles spent rows')
  for (const [, selector, body] of rules) {
    assert.equal(/(^|;|\s)color\s*:/.test(body), false, `${selector.trim()} sets a colour`)
  }
})

test('the template has no retired tokens and uses only the panel palette colours', () => {
  assert.equal(PAGE.includes('--grazr-spent'), false)
  assert.equal(PAGE.includes('--grazr-bad'), false)
  // #999 is the only allowed fallback for muted-foreground; the other four are the panel palette itself.
  // The five account hues are the clock's device palette (the spec's colour paragraph), one per account on the ring.
  // #171717 is the dial tooltip's popover fallback (the spec's Dial tooltips section): Orca's dark popover colour.
  const allowed = new Set(['#4ade80', '#f97316', '#fbbf24', '#f87171', '#999', '#171717', '#8b5cf6', '#14b8a6', '#ec4899', '#818cf8', '#c9964a',
    // html.light: the darker hues for a light card, checked at 4.5:1 or better in theme.test.mjs.
    '#15803d', '#c2410c', '#b45309', '#6d28d9', '#0f766e', '#be185d', '#4338ca', '#8a5a1c'])
  const used = [...PAGE.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase())
  assert.deepEqual(used.filter((hex) => !allowed.has(hex)), [])
})

// A reachable host from a report with a version, built the way the refresher builds it.
const reachableHost = (value, bundledVersion = '0.4.7+fork.6', enabled = true) => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const data = buildPanelData({
    settings,
    now: new Date('2026-10-22T00:24:00Z'),
    timeZone: 'Europe/Zurich',
    bundledVersion,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value: { ...value, settings: { ...value.settings, enabled } } } }],
  })
  return data.hosts[0]
}

test('renderCard shows the updated time from updatedAt in the given zone, 24 h', () => {
  const host = reachableHost({ ...report(), version: '0.4.7+fork.6' })
  const html = renderCard(host, {}, { timeZone: 'Europe/Zurich' })
  assert.ok(html.includes('<p class="thresholds">swaps below 15% 5h · 20% week · updated 02:24</p>'))
})

test('renderCard shows the engine version under the thresholds, and engine — when the report has none', () => {
  const current = renderCard(reachableHost({ ...report(), version: '0.4.7+fork.6' }, '0.4.7+fork.6'), {})
  assert.ok(current.includes('<p class="engine">engine 0.4.7+fork.6</p>'))
  assert.ok(!current.includes('engine update available'))
  const unknown = renderCard(reachableHost(report(), '0.4.7+fork.6'), {})
  assert.ok(unknown.includes('<p class="engine">engine —</p>'))
})

test('renderCard marks an outdated engine with an orange chip and a default message that says how to update', () => {
  const host = { ...reachableHost({ ...report(), version: '0.4.7+fork.5' }, '0.4.7+fork.6'), open: true }
  const html = renderCard(host, {})
  assert.ok(html.includes('<span class="chip chip-outdated">engine update available</span>'))
  assert.ok(html.includes('<p class="msg" data-host="mac">Engine 0.4.7+fork.5 · 0.4.7+fork.6 bundled — Cmd-J › Grazr: Install engine on target</p>'))
})

test('renderCard has a rotation button that types the off command while rotation is on, and the on command while off', () => {
  const commands = { mac: { refresh: 'R', enrol: 'E', swap: 'S', swapTo: {}, rotationOn: 'ON1', rotationOff: 'OFF0' } }
  const on = renderCard(reachableHost(report(), '0.4.7+fork.6', true), commands)
  assert.ok(on.includes('<button class="act act-rotation" data-host="mac" data-text="OFF0" data-command="rotation-toggle" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;enabled&quot;:false}">Turn rotation off</button>'))
  const off = renderCard(reachableHost(report(), '0.4.7+fork.6', false), commands)
  assert.ok(off.includes('<button class="act act-rotation" data-host="mac" data-text="ON1" data-command="rotation-toggle" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;enabled&quot;:true}">Turn rotation on</button>'))
  const unreachable = renderCard(panelOf(report()).hosts[1], commands)
  assert.ok(!unreachable.includes('act-rotation'))
})

test('the page footer no longer carries the global as-of time', () => {
  const html = renderPanel(panelOf(report()), { template: PAGE, commands: {} })
  assert.ok(!html.includes("'as of '"))
  assert.ok(html.includes("textContent = 'Cmd-J Grazr: Refresh panel'"))
})

test('renderPanel escapes an engine version that carries markup and quotes, in the engine and message lines', () => {
  const version = `<x>"'&`
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const data = buildPanelData({
    settings,
    now: new Date('2026-10-22T00:24:00Z'),
    bundledVersion: '0.4.7+fork.6',
    hosts: [{ host: settings.hosts[0], result: { ok: true, value: { ...report(), version } } }],
  })
  const html = renderPanel(data, { template: TEMPLATE, commands: {} })
  assert.equal(html.includes('<x>'), false)
  assert.ok(html.includes('<p class="engine">engine &lt;x&gt;"\'&amp;</p>'))
  assert.ok(html.includes('<p class="msg" data-host="mac">Engine &lt;x&gt;"\'&amp; · 0.4.7+fork.6 bundled'))
})

test('a non-target outdated card says to target through to it, and its summary shows the engine chip', () => {
  const host = { ...reachableHost({ ...report(), version: '0.4.7+fork.5' }, '0.4.7+fork.6'), open: false }
  const html = renderCard(host, {})
  assert.ok(html.includes('Grazr: Target → next host until mac, then Grazr: Install engine on target</p>'))
  assert.ok(html.includes('<summary>mac <span class="chip chip-on">rotation on</span><span class="chip chip-outdated">engine update available</span></summary>'))
})

test('the target outdated card keeps the install message, and a current non-target summary has no engine chip', () => {
  const target = renderCard({ ...reachableHost({ ...report(), version: '0.4.7+fork.5' }, '0.4.7+fork.6'), open: true }, {})
  assert.ok(target.includes('Grazr: Install engine on target</p>'))
  assert.ok(!target.includes('Target → next host'))
  const current = renderCard({ ...reachableHost({ ...report(), version: '0.4.7+fork.6' }, '0.4.7+fork.6'), open: false }, {})
  assert.equal(current.includes('engine update available'), false)
})

test('the footer buttons lay out as a responsive grid, one row when wide and a grid when narrow, and Swap to rows stay unstretched', () => {
  assert.ok(PAGE.includes('.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }'))
  assert.ok(PAGE.includes('@media (min-width: 540px) { .actions { grid-template-columns: repeat(4, minmax(0, 1fr)); } }'))
  assert.equal(/\.actions\s*\{[^}]*flex/.test(PAGE), false)
  assert.ok(/\.row > \.act\s*\{[^}]*justify-self: start/.test(PAGE))
  assert.ok(PAGE.includes('.actions > .act:only-child { justify-self: start; }'))
})

test('the template scopes the ellipsis and nowrap rules to the footer buttons, so the row buttons keep their style', () => {
  assert.ok(PAGE.includes('.actions > .act {'))
  assert.equal(/(^|\n)\s*\.act\s*\{[^}]*overflow/.test(PAGE), false)
  assert.equal(/(^|\n)\s*\.act\s*\{[^}]*white-space/.test(PAGE), false)
})
