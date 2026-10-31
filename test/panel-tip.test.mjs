import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData } from '../lib/panel-data.mjs'
import { ringSvg } from '../lib/panel.mjs'

const NOW = new Date('2026-10-21T10:00:00Z')
const TZ = 'Europe/Zurich'
const PAGE = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')

const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at: null })

// a: active, 42.4% left resetting Wed 18:00 Zurich; b: next; c: blocked; d: ok; e: spent on the 5h; f: named, no record; g: no 5h reading.
const report = () => ({
  active: { id: 'a', name: 'a' },
  order: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, in_order: true, snapshot: [session(42.4, '2026-10-21T18:00:00+02:00'), weekly(70)] },
    { id: 'b', name: 'b', parked: true, blocked: null, in_order: true, snapshot: [session(100), weekly(100)] },
    { id: 'c', name: 'c', parked: true, blocked: 'authentication_failed', in_order: true, snapshot: [session(50), weekly(50)] },
    { id: 'd', name: 'd', parked: false, blocked: null, in_order: true, snapshot: [session(60), weekly(60)] },
    { id: 'e', name: 'e', parked: true, blocked: null, in_order: true, snapshot: [session(10, '2026-10-21T18:00:00+02:00'), weekly(60)] },
    { id: 'g', name: 'g', parked: true, blocked: null, in_order: true, snapshot: [weekly(90)] },
  ],
})

const segmentsOf = (r, view = 'session') => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac' }, now: NOW, timeZone: TZ, hosts: [{ host: { name: 'mac' }, result: { ok: true, value: r } }],
}).hosts[0].views[view].segments

// --- buildView: every segment carries name, remaining, resets and tone ---

test('each dial segment carries its window reading, formatted reset and the row tone', () => {
  const segments = segmentsOf(report())
  const byName = Object.fromEntries(segments.map((s) => [s.name, s]))
  // models and usable are the model rings' fields, checked in panel-rings.test.mjs.
  const { models, usable, ...dial } = byName.a
  assert.deepEqual(dial, { index: 1, name: 'a', remaining: 42.4, resets: 'Wed 18:00', tone: 'fine', state: 'active', noLimit: false, noLimitText: null })
  assert.equal(byName.b.tone, 'warning', 'next')
  assert.equal(byName.c.tone, 'blocked')
  assert.equal(byName.c.remaining, null)
  assert.equal(byName.c.resets, null)
  assert.equal(byName.d.tone, 'fine', 'ok')
  assert.equal(byName.e.tone, 'spent')
  assert.equal(byName.e.remaining, 10)
  assert.equal(byName.e.resets, 'Wed 18:00')
  assert.equal(byName.f.tone, 'none', 'not enrolled')
  assert.equal(byName.f.remaining, null)
  assert.equal(byName.f.resets, null)
  assert.equal(byName.g.tone, 'none', 'unread: no 5h reading')
  assert.equal(byName.g.resets, null)
})

test('the weekly dial takes the weekly window and its reset', () => {
  const byName = Object.fromEntries(segmentsOf(report(), 'weekly').map((s) => [s.name, s]))
  assert.equal(byName.a.remaining, 70)
  assert.equal(byName.a.resets, null, 'the weekly entry has no reset')
})

// --- ringSvg: the six data-tip attributes on each segment ---

const tipsOf = (svg) => [...svg.matchAll(/<path class="seg[^"]*"[^>]*>/g)].map((m) => Object.fromEntries(
  [...m[0].matchAll(/data-tip-(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
))

test('ringSvg puts label, left, tone, name, tick and resets on every segment path', () => {
  const data = buildPanelData({ settings: { hosts: [{ name: 'mac' }], target: 'mac' }, now: NOW, timeZone: TZ, hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report() } }] })
  const tips = tipsOf(ringSvg(data.hosts[0].views.session))
  assert.equal(tips.length, 7)
  assert.deepEqual(tips[0], { label: 'All models', left: '42% left', tone: 'fine', name: 'a', tick: 'tick: grazr swaps below 15%', resets: 'resets Wed 18:00' })
  assert.deepEqual(tips[2], { label: 'All models', left: 'no reading', tone: 'blocked', name: 'c', tick: 'tick: grazr swaps below 15%' })
  assert.equal(tips[4].left, '10% left')
})

test('ringSvg leaves the tick empty when the report sets no threshold', () => {
  const svg = ringSvg({ centre: { tone: 'none' }, threshold: null, segments: [{ index: 1, name: 'a', remaining: 5, state: 'ok', tone: 'spent', resets: null }] })
  assert.deepEqual(tipsOf(svg)[0], { label: 'All models', left: '5% left', tone: 'spent', name: 'a' })
})

test('ringSvg escapes the name and the other tip text', () => {
  const svg = ringSvg({ centre: { tone: 'none' }, threshold: 15, segments: [{ index: 1, name: '<i>"Q"&\'', remaining: 5, state: 'ok', tone: 'fine', resets: '<x>' }] })
  assert.ok(svg.includes('data-tip-name="&lt;i&gt;&quot;Q&quot;&amp;&#39;"'))
  assert.ok(svg.includes('data-tip-resets="resets &lt;x&gt;"'))
  assert.equal(svg.includes('<i>'), false)
})

test('a segment with no tone, tick or resets leaves those tip attributes out', () => {
  const svg = ringSvg({ centre: { tone: 'none' }, threshold: null, segments: [{ index: 1, name: 'a', remaining: null, state: 'unknown' }] })
  const tip = tipsOf(svg)[0]
  assert.deepEqual(Object.keys(tip).sort(), ['label', 'left', 'name'])
  assert.equal(tip.left, 'no reading')
})

// --- template: the tooltip element and its script ---

test('the template has one tooltip element, a delegated mouseover script and no inline handlers', () => {
  assert.equal(PAGE.split('class="tip"').length - 1, 1)
  assert.ok(PAGE.includes('<div class="tip" hidden></div>'))
  assert.ok(PAGE.includes("document.addEventListener('mouseover'"))
  assert.ok(PAGE.includes("document.addEventListener('mouseout'"))
  assert.ok(PAGE.includes("document.addEventListener('mousemove'"))
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(PAGE), false, 'an on* attribute')
})

test('the tooltip is kept inside the viewport and built with textContent, never innerHTML', () => {
  assert.ok(PAGE.includes('Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)'))
  assert.ok(PAGE.includes('Math.min(e.clientY + 12, innerHeight - tip.offsetHeight - 8)'))
  assert.ok(PAGE.includes('textContent'))
  const tipScript = PAGE.slice(PAGE.indexOf('function tipFill'), PAGE.indexOf('</script>', PAGE.indexOf('function tipFill')))
  assert.equal(tipScript.includes('innerHTML'), false)
})
