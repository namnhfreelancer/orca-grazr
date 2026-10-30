import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData, centre, modelScopes } from '../lib/panel-data.mjs'
import { arcPath, escapeAttr, escapeHtml, renderCard, ringSvg } from '../lib/panel.mjs'
import { polar } from '../lib/clock.mjs'

const NOW = new Date('2026-10-21T10:00:00Z')
const TZ = 'Europe/Zurich'

const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })
const scoped = (scope, remaining, resets_at = null) => ({ kind: 'weekly_scoped', scope, group: 'weekly', remaining, resets_at })

// The report of the list tests, with model limits on: a is active, b is parked and short on Fable, c is blocked,
// d is parked and full, with an expired Opus window, and e is named in the order with no record.
const modelReport = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c', 'd', 'e'],
  settings: { enabled: true, model_limits: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, in_order: true,
      snapshot: [session(42), weekly(70), scoped('Opus', 40), scoped('Fable', 79.4, '2026-10-27T09:00:00+02:00')] },
    { id: 'b', name: 'b', parked: true, blocked: null, in_order: true,
      snapshot: [session(100), weekly(100), scoped('Fable', 3)] },
    { id: 'c', name: 'c', parked: true, blocked: 'authentication_failed', in_order: true,
      snapshot: [session(50), weekly(50), scoped('Fable', 50)] },
    { id: 'd', name: 'd', parked: true, blocked: null, in_order: true,
      snapshot: [session(100), weekly(100), scoped('Fable', 79), scoped('Opus', 60, '2026-10-20T09:00:00+02:00')] },
  ],
})

const viewsOf = (report) => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac' },
  now: NOW,
  timeZone: TZ,
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
}).hosts[0].views

// Golden: the weekly dial of a report with no model limits, as the markup stood before the model rings, less the empty
// tooltip attributes the page no longer writes (the blank resets of the segments with no reset). Its tooltips sit above the
// threshold, so the tick wording and the needle reach are the ones the page always drew.
test('ringSvg with no models draws the weekly dial byte-for-byte as before the model rings', () => {
  const report = {
    active: { id: 'a', name: 'a', enrolled: true, in_order: true },
    order: ['a', 'b', 'c', 'd'],
    settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
    accounts: [
      { id: 'a', name: 'a', parked: false, blocked: null, snapshot: [session(42.01, '2026-10-21T18:00:00+02:00'), weekly(70, '2026-10-27T09:00:00+02:00')] },
      { id: 'b', name: 'b', parked: true, blocked: null, snapshot: [session(100), weekly(100)] },
      { id: 'c', name: 'c', parked: true, blocked: null, snapshot: [session(5, '2026-10-24T13:00:00+02:00'), weekly(45)] },
      { id: 'd', name: 'd', parked: true, blocked: 'authentication_failed', snapshot: null },
    ],
  }
  const svg = ringSvg(viewsOf(report).weekly)
  assert.equal(svg.length, 2262)
  assert.equal(createHash('sha256').update(svg).digest('hex'), '7dbd818139feed73da17b729dd70564680fbf8f80c387371cbfefb4d75f890c4')
})

// --- Data: modelScopes ---

test('modelScopes lists the distinct weekly scopes sorted by code unit, and nothing without model limits', () => {
  const report = modelReport()
  assert.deepEqual(modelScopes(report), ['Fable', 'Opus'])
  report.accounts[0].snapshot.push(scoped('Sonnet', 10), scoped('Fable', 5))
  assert.deepEqual(modelScopes(report), ['Fable', 'Opus', 'Sonnet'])
  report.settings.model_limits = false
  assert.deepEqual(modelScopes(report), [])
})

test('modelScopes takes only weekly entries that carry a string scope', () => {
  const report = modelReport()
  report.accounts[0].snapshot.push({ kind: 'session_scoped', scope: 'Haiku', group: 'session', remaining: 5, resets_at: null })
  report.accounts[0].snapshot.push({ kind: 'weekly_odd', scope: 7, group: 'weekly', remaining: 5, resets_at: null })
  assert.deepEqual(modelScopes(report), ['Fable', 'Opus'])
})

test('the weekly view carries the model scopes and the session view carries none', () => {
  const views = viewsOf(modelReport())
  assert.deepEqual(views.weekly.models, ['Fable', 'Opus'])
  assert.deepEqual(views.session.models, [])
})

test('a view without model limits carries an empty models list', () => {
  const report = modelReport()
  report.settings.model_limits = false
  assert.deepEqual(viewsOf(report).weekly.models, [])
})

// --- Data: segment models and usable ---

test('each segment lists its models in the view order, with the live weekly reading, its reset and tone', () => {
  const [a, b, c, d, e] = viewsOf(modelReport()).weekly.segments
  assert.deepEqual(a.models, [
    { scope: 'Fable', remaining: 79.4, resets: 'Tue 08:00', tone: 'fine' },
    { scope: 'Opus', remaining: 40, resets: null, tone: 'fine' },
  ])
  // Fable at 3 rounds above the spent line and sits under the weekly threshold of 20: warning.
  assert.deepEqual(b.models, [
    { scope: 'Fable', remaining: 3, resets: null, tone: 'warning' },
    { scope: 'Opus', remaining: null, resets: null, tone: 'none' },
  ])
  // A blocked account shows no model reading, whatever its snapshot says.
  assert.deepEqual(c.models.map((m) => [m.remaining, m.tone]), [[null, 'none'], [null, 'none']])
  // An expired Opus window counts as absent; the live Fable window is read.
  assert.deepEqual(d.models.map((m) => [m.scope, m.remaining, m.tone]), [['Fable', 79, 'fine'], ['Opus', null, 'none']])
  // A placeholder has no reading at all.
  assert.deepEqual(e.models.map((m) => m.remaining), [null, null])
})

test('a model at or under the spent line reads spent', () => {
  const report = modelReport()
  report.accounts[1].snapshot.push(scoped('Opus', 2))
  const [, b] = viewsOf(report).weekly.segments
  assert.equal(b.models[1].tone, 'spent')
})

test('the active account is always usable; the others only when not blocked and not short on any live window', () => {
  const segments = viewsOf(modelReport()).weekly.segments
  // a: active. b: short on Fable (3 under the threshold). c: blocked. d: full. e: a placeholder.
  assert.deepEqual(segments.map((s) => s.usable), [true, false, false, true, false])
})

test('every segment carries a usable flag, on the session view too', () => {
  const views = viewsOf(modelReport())
  for (const seg of [...views.session.segments, ...views.weekly.segments]) assert.equal(typeof seg.usable, 'boolean')
})

// --- Data: centre models ---

test('centre without the scopes returns exactly the centre it returned before', () => {
  const report = modelReport()
  const plain = centre(report, 'weekly', { now: NOW })
  assert.deepEqual(Object.keys(plain).sort(), ['hint', 'name', 'nextName', 'percentText', 'tone'])
})

test('centre with the scopes lists the active account\'s live model windows in the scope order, rounded', () => {
  const report = modelReport()
  const c = centre(report, 'weekly', { now: NOW, models: ['Fable', 'Opus'] })
  assert.deepEqual(c.models, [
    { scope: 'Fable', left: 79, tone: 'fine' },
    { scope: 'Opus', left: 40, tone: 'fine' },
  ])
  assert.equal(c.percentText, '70% left')
})

test('centre skips a scope the active account has no live window for, and an empty scope list gives no lines', () => {
  const report = modelReport()
  report.active = { id: 'b', name: 'b' }
  assert.deepEqual(centre(report, 'weekly', { now: NOW, models: ['Fable', 'Opus'] }).models, [{ scope: 'Fable', left: 3, tone: 'warning' }])
  assert.deepEqual(centre(report, 'weekly', { now: NOW, models: [] }).models, [])
})

// --- Markup: model rings ---

const CX = 110
const STEP = 72 // five accounts: each slice is 72 degrees apart, with a 2 degree half gap, so it spans 68 degrees
const sliceOf = (i) => [i * STEP + 2, i * STEP + 70]
const tagWith = (svg, cls, text) => [...svg.matchAll(new RegExp(`<[a-z]+ class="${cls}[^"]*"[^>]*>`, 'g'))]
  .map((m) => m[0]).find((tag) => tag.includes(text))
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const weeklyView = (report = modelReport()) => viewsOf(report).weekly

test('a weekly view with two scopes draws a track per scope on each slice, at the inner radii', () => {
  const svg = ringSvg(weeklyView())
  assert.equal((svg.match(/class="mseg mseg-track"/g) ?? []).length, 10)
  for (let i = 0; i < 5; i++) {
    const [start, end] = sliceOf(i)
    assert.ok(svg.includes(`stroke-width="5"`) && svg.includes(`d="${arcPath(CX, CX, 65.5, start, end)}"`), `ring 0 slice ${i}`)
    assert.ok(svg.includes(`d="${arcPath(CX, CX, 57.5, start, end)}"`), `ring 1 slice ${i}`)
  }
})

test('the model fill starts where the reading says, and runs to the slice end', () => {
  const svg = ringSvg(weeklyView())
  // Fable on the active account is 79.4% left: the fill starts 20.6% of the way round the slice.
  const from = 2 + (1 - 79.4 / 100) * (70 - 2)
  assert.ok(svg.includes(`<path class="mseg mseg-fill tone-fine"`))
  assert.ok(svg.includes(`d="${arcPath(CX, CX, 65.5, from, 70)}"`))
})

test('a model fill is drawn only for a reading above zero, and a blocked or missing account draws none', () => {
  const svg = ringSvg(weeklyView())
  // Fable and Opus on a, Fable on b, Fable on d: four fills; c is blocked and e is a placeholder.
  assert.equal((svg.match(/class="mseg mseg-fill /g) ?? []).length, 4)
})

test('a fill on an account the rotation would not move to is dimmed', () => {
  const svg = ringSvg(weeklyView())
  // b is short on Fable, so it is not usable: its fill carries the dim class and the warning tone.
  assert.ok(svg.includes('class="mseg mseg-fill tone-warning dim"'))
  assert.equal((svg.match(/mseg-fill tone-[a-z]+ dim/g) ?? []).length, 1)
})

test('each model ring draws a radial swap tick at the threshold, four units either side of its track', () => {
  const svg = ringSvg(weeklyView())
  assert.equal((svg.match(/class="mtick"/g) ?? []).length, 10)
  const [start, end] = sliceOf(0)
  const at = start + (1 - 20 / 100) * (end - start)
  const [x1, y1] = polar(CX, CX, 61.5, at)
  const [x2, y2] = polar(CX, CX, 69.5, at)
  assert.ok(svg.includes(`<line class="mtick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`))
})

test('no swap tick is drawn on the model rings without a weekly threshold', () => {
  const view = weeklyView()
  view.threshold = null
  const svg = ringSvg(view)
  assert.equal(svg.includes('class="mtick"'), false)
  assert.equal(attrsOf(tagWith(svg, 'mseg mseg-track', 'Fable'))['data-tip-tick'], undefined)
})

test('a model track\'s tooltip names the scope, its reading, the tone, the account and the reset', () => {
  const svg = ringSvg(weeklyView())
  const tip = attrsOf(tagWith(svg, 'mseg mseg-track', 'data-tip-label="Fable"'))
  assert.equal(tip['data-tip-label'], 'Fable')
  assert.equal(tip['data-tip-left'], '79% left')
  assert.equal(tip['data-tip-tone'], 'fine')
  assert.equal(tip['data-tip-name'], 'a')
  assert.equal(tip['data-tip-tick'], 'tick: grazr swaps below 20%')
  assert.equal(tip['data-tip-tick-tone'], undefined)
  assert.equal(tip['data-tip-resets'], 'resets Tue 08:00')
})

test('a model below the weekly threshold reads below the swap tick in the warning tone', () => {
  const svg = ringSvg(weeklyView())
  const tip = attrsOf(tagWith(svg, 'mseg mseg-track', 'data-tip-name="b"'))
  assert.equal(tip['data-tip-left'], '3% left')
  assert.equal(tip['data-tip-tick'], 'below the 20% swap tick')
  assert.equal(tip['data-tip-tick-tone'], 'warning')
  assert.equal(tip['data-tip-resets'], undefined)
})

test('a blocked account\'s model track reads no reading, and its fill carries no tooltip', () => {
  const svg = ringSvg(weeklyView())
  const track = attrsOf(tagWith(svg, 'mseg mseg-track', 'data-tip-name="c"'))
  assert.equal(track['data-tip-left'], 'no reading')
  assert.equal(track['data-tip-tone'], 'none')
  const fillTag = svg.match(/<path class="mseg mseg-fill[^"]*"[^>]*>/)[0]
  assert.equal(fillTag.includes('data-tip-'), false)
})

test('the main ring tooltip titles All models on the weekly view and 5-hour window on the session view', () => {
  const view = weeklyView()
  const weekly = attrsOf(tagWith(ringSvg(view), 'seg seg-active', 'data-tip-name="a"'))
  assert.equal(weekly['data-tip-label'], 'All models')
  const session = attrsOf(tagWith(ringSvg(view, 'session'), 'seg seg-active', 'data-tip-name="a"'))
  assert.equal(session['data-tip-label'], '5-hour window')
})

test('the main ring tooltip says below the swap tick in the warning tone when its reading is under the threshold', () => {
  const view = {
    centre: { name: 'x', percentText: '12% left', hint: 'fine', tone: 'warning' },
    threshold: 20,
    rows: [],
    models: [],
    segments: [{ index: 1, name: 'x', remaining: 12, tone: 'warning', state: 'active', resets: null }],
  }
  const tip = attrsOf(tagWith(ringSvg(view), 'seg seg-active', 'data-tip-name="x"'))
  assert.equal(tip['data-tip-tick'], 'below the 20% swap tick')
  assert.equal(tip['data-tip-tick-tone'], 'warning')
})

test('a reading that rounds up to the threshold keeps the rule wording: it is shown as the threshold, not below it', () => {
  const view = weeklyView()
  view.segments[0].remaining = 19.6
  const tip = attrsOf(tagWith(ringSvg(view), 'seg seg-active', 'data-tip-name="a"'))
  assert.equal(tip['data-tip-left'], '20% left')
  assert.equal(tip['data-tip-tick'], 'tick: grazr swaps below 20%')
  assert.equal(tip['data-tip-tick-tone'], undefined)
})

test('the main ring tooltip keeps the rule wording and no tick tone when its reading is above the threshold', () => {
  const tip = attrsOf(tagWith(ringSvg(weeklyView()), 'seg seg-active', 'data-tip-name="a"'))
  assert.equal(tip['data-tip-tick'], 'tick: grazr swaps below 20%')
  assert.equal(tip['data-tip-tick-tone'], undefined)
})

test('the needle runs from the innermost model ring out to the rim, and its dot sits at the inner end', () => {
  const svg = ringSvg(weeklyView())
  // Two model rings: the inner edge is the second ring at 57.5, less its half width, so the needle starts 3 short of 55.
  const needle = 2 + (1 - 70 / 100) * (70 - 2)
  const [x1, y1] = polar(CX, CX, 52, needle)
  const [x2, y2] = polar(CX, CX, 93, needle)
  assert.ok(svg.includes(`<line class="needle" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`))
  assert.ok(svg.includes(`<circle class="needle-dot" cx="${x1}" cy="${y1}" r="3.5"/>`))
})

test('the needle reaches in to the single model ring and never past the three drawn', () => {
  const one = weeklyView()
  one.models = ['Fable']
  const needle = 2 + (1 - 70 / 100) * (70 - 2)
  const [x1, y1] = polar(CX, CX, 60, needle)
  assert.ok(ringSvg(one).includes(`<circle class="needle-dot" cx="${x1}" cy="${y1}" r="3.5"/>`))
  const four = weeklyView()
  four.models = ['Fable', 'Opus', 'Sonnet', 'Haiku']
  const svg = ringSvg(four)
  assert.equal((svg.match(/class="mseg mseg-track"/g) ?? []).length, 15)
  // Four scopes draw three rings; the inner edge is the third ring at 49.5, less its half width, so the needle starts at 44.
  const [x3, y3] = polar(CX, CX, 44, needle)
  assert.ok(svg.includes(`<circle class="needle-dot" cx="${x3}" cy="${y3}" r="3.5"/>`))
})

test('the centre lists the model windows under the name, and moves the name and percentage up to make room', () => {
  const svg = ringSvg(weeklyView())
  assert.ok(svg.includes('<text class="centre-name" x="110" y="90"'))
  assert.ok(svg.includes('<text class="centre-pct tone-fine" x="110" y="112"'))
  assert.match(svg, /<text class="centre-model tone-fine" x="110" y="126" font-size="10" text-anchor="middle"><title>Fable 79% left<\/title>Fable 79% left<\/text>/)
  assert.match(svg, /<text class="centre-model tone-fine" x="110" y="136" font-size="10" text-anchor="middle"><title>Opus 40% left<\/title>Opus 40% left<\/text>/)
  assert.ok(svg.includes('<text class="centre-hint" x="110" y="148"'))
  assert.ok(svg.includes('<text class="centre-next" x="110" y="158"'))
  assert.ok(svg.includes('<text class="centre-next-name" x="110" y="169"'))
})

test('the centre shows at most two model lines', () => {
  const view = weeklyView()
  view.centre.models = [{ scope: 'A', left: 1, tone: 'fine' }, { scope: 'B', left: 2, tone: 'fine' }, { scope: 'C', left: 3, tone: 'fine' }]
  const svg = ringSvg(view)
  assert.equal((svg.match(/class="centre-model /g) ?? []).length, 2)
  assert.equal(svg.includes('>C 3% left<'), false)
})

test('the centre keeps its old lines when there are no model lines', () => {
  const svg = ringSvg(viewsOf(modelReport()).session)
  assert.ok(svg.includes('<text class="centre-name" x="110" y="92"'))
  assert.ok(svg.includes('<text class="centre-pct tone-fine" x="110" y="120"'))
  assert.equal(svg.includes('centre-model'), false)
})

test('the session view draws no model rings', () => {
  const svg = ringSvg(viewsOf(modelReport()).session)
  assert.equal(svg.includes('mseg'), false)
  assert.equal(svg.includes('mtick'), false)
})

test('a model ring stays in the scope list footnote; only three rings are drawn when there are more scopes', () => {
  const view = weeklyView()
  view.models = ['Fable', 'Opus', 'Sonnet', 'Haiku']
  assert.equal((ringSvg(view).match(/class="mseg mseg-track"/g) ?? []).length, 15)
})

// --- Markup: the footnote and its escaping ---

const cardOf = (report) => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const [mac] = buildPanelData({
    settings, now: NOW, timeZone: TZ, hosts: [{ host: settings.hosts[0], result: { ok: true, value: report } }],
  }).hosts
  return mac
}

test('the weekly block carries the footnote naming the outer and inner rings, and the session block has none', () => {
  const html = renderCard({ ...cardOf(modelReport()), open: true }, {})
  assert.equal((html.match(/<p class="dial-note">/g) ?? []).length, 1)
  assert.ok(html.includes('<p class="dial-note">Outer ring: all models · inner: Fable, Opus</p>'))
  const weeklyStart = html.indexOf('<div class="view-weekly">')
  const note = html.indexOf('<p class="dial-note">')
  assert.ok(note > weeklyStart && note < html.indexOf('<div class="clock"', weeklyStart))
})

test('the footnote is left out when the report has no model limits', () => {
  const report = modelReport()
  report.settings.model_limits = false
  const html = renderCard({ ...cardOf(report), open: true }, {})
  assert.equal(html.includes('dial-note'), false)
})

test('the footnote escapes a scope that carries markup and quotes', () => {
  const report = modelReport()
  report.accounts[0].snapshot.push(scoped('Q"<x>', 10))
  const html = renderCard({ ...cardOf(report), open: true }, {})
  assert.ok(html.includes('inner: Fable, Opus, Q"&lt;x&gt;</p>'))
  assert.equal(html.includes('<x>'), false)
})

// --- Escaping of a scope in the tooltip and the centre, and the four-scope case ---

test('a scope with markup and quotes is escaped in the tooltip attributes and the centre line', () => {
  const scope = 'Fa<ble"'
  const report = modelReport()
  report.accounts[0].snapshot.push(scoped(scope, 60))
  const svg = ringSvg(weeklyView(report))
  assert.ok(svg.includes(`data-tip-label="${escapeAttr(scope)}"`))
  assert.ok(svg.includes(`<title>${escapeHtml(`${scope} 60% left`)}</title>`))
  assert.equal(svg.includes('Fa<ble'), false)
})

test('with four scopes three rings are drawn and the footnote lists all four in sorted order', () => {
  const report = modelReport()
  report.accounts[0].snapshot.push(scoped('Sonnet', 10), scoped('Haiku', 20))
  const html = renderCard({ ...cardOf(report), open: true }, {})
  assert.ok(html.includes('<p class="dial-note">Outer ring: all models · inner: Fable, Haiku, Opus, Sonnet</p>'))
  const svg = ringSvg(weeklyView(report))
  assert.equal((svg.match(/class="mseg mseg-track"/g) ?? []).length, 15)
  assert.equal(svg.includes('data-tip-label="Sonnet"'), false)
})
