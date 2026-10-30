// The clock behind the Claude Accounts panel: ring geometry and centre-text fitting (shared with the dial), the rotation
// projection over time (`project`), and the clock face drawn from it (`clockSvg`, with `turn`, `timeLabel` and `HORIZON`).
// Self-contained: lib/clock.mjs is pasted verbatim into the page's inline module script, so it imports nothing and
// uses no top-level await.

const MIN_SWEEP = 0.1
const MAX_SWEEP = 359.9
// The inner circle of the ring, which the centre text must fit inside.
const INNER_R = 66
const CENTRE_CENTRE = 110
// Room kept between a centre line and the inner circle, in px.
const FIT_MARGIN = 4

const text = (s) => String(s ?? '')

// Estimated width of one character in em, measured against the system font at the ring's sizes.
// Full-width CJK and symbols are one em; other non-ASCII is wide; capitals, digits and some letters are wide too.
const WIDE_LATIN = new Set(['M', 'W', 'm', 'w', '@'])
const NARROW = new Set(['i', 'j', 'l', 't', 'f', '.', ',', "'", ':', '|', '!', ' '])
function emOf(ch) {
  const code = ch.codePointAt(0)
  if (code >= 0x2e80) return 1.0
  if (WIDE_LATIN.has(ch)) return 0.95
  if (code > 0x7f) return 0.8
  if (/[A-Z0-9]/.test(ch)) return 0.78
  if (NARROW.has(ch)) return 0.32
  return 0.62
}
export const widthOf = (s, size) => [...s].reduce((sum, ch) => sum + emOf(ch) * size, 0)

// The width of the inner circle at a text line, measured at the glyph box's edge farthest from the centre:
// its top (baseline minus 0.75 of the size) or its bottom (a quarter of the size below the baseline).
export function chordAt(y, size) {
  const dy = Math.max(Math.abs(y - 0.75 * size - CENTRE_CENTRE), Math.abs(y + 0.25 * size - CENTRE_CENTRE))
  return 2 * Math.sqrt(Math.max(0, INNER_R * INNER_R - dy * dy))
}

// The text cut by estimated width to fit its line of the centre, with an ellipsis when cut; the full text stays in a title.
export function fitText(s, { y, size }) {
  const full = text(s)
  const budget = chordAt(y, size) - FIT_MARGIN
  if (widthOf(full, size) <= budget) return full
  const chars = [...full]
  let kept = chars.length
  while (kept > 0 && widthOf(`${chars.slice(0, kept).join('')}…`, size) > budget) kept -= 1
  return `${chars.slice(0, kept).join('')}…`
}

const round = (n) => Number(n.toFixed(2))

// Point on a circle, 0 degrees at 12 o'clock, clockwise.
export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [round(cx + r * Math.sin(a)), round(cy - r * Math.cos(a))]
}

// The sweep is clamped so a full 0 to 360 request never draws a degenerate arc.
export function arcPath(cx, cy, r, startDeg, endDeg) {
  const sweep = Math.min(Math.max(endDeg - startDeg, MIN_SWEEP), MAX_SWEEP)
  const [x1, y1] = polar(cx, cy, r, startDeg)
  const [x2, y2] = polar(cx, cy, r, startDeg + sweep)
  const large = sweep > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

// The projection: grazr's rotation laid out over time, from the clock data in lib/panel-data.mjs.
// A port of HerdrKit's GrazrTimeline (Packages/HerdrKit/Sources/HerdrKit/GrazrTimeline.swift). Times are unix seconds.
export const MAX_STRETCHES = 200
const MIN_PACE_SAMPLE = 1800
const TOLERANCE = 0.01
const LENGTH = { session: 5 * 3600, weekly: 7 * 86400 }

const threshold = (clock, group) => {
  const value = clock.thresholds?.[group]
  return Number.isFinite(value) ? value : null
}
const watched = (clock, window) => threshold(clock, window.group) !== null
const length = (group) => LENGTH[group] ?? null
const rateKey = (group, scope) => `${group}|${scope ?? ''}`
const isBlocked = (account) => account.blocked === true

// A window as the projection carries it forward.
function projected(window) {
  return { group: window.group, scope: window.scope, remaining: Number(window.remaining), resetsAt: window.resetsAt, length: length(window.group) }
}

// The window as it stands at `time`: past its reset it is full again. A 5-hour window starts over at the
// first use after that (taken to be `time`); a weekly one keeps its weekly cadence.
function settled(window, time) {
  if (window.resetsAt == null || window.resetsAt > time) return window
  const next = { ...window, remaining: 100 }
  if (window.length === null) {
    next.resetsAt = null
  } else if (window.group === 'session') {
    next.resetsAt = time + window.length
  } else {
    const periods = Math.floor((time - window.resetsAt) / window.length) + 1
    next.resetsAt = window.resetsAt + periods * window.length
  }
  return next
}

// Percent per second each watched window loses, from the active account's last reading, keyed by group and model.
// A window read in its first half hour gives none: right after a swap Claude reloads its context, and those minutes
// extrapolate to an account running dry within the hour.
function burnRates(clock, rotation, now) {
  const current = rotation.find((a) => a.id === clock.active)
  if (!current || !Number.isFinite(current.updated)) return {}
  const rates = {}
  for (const window of current.windows) {
    const len = length(window.group)
    if (!watched(clock, window) || window.resetsAt == null || !(window.resetsAt > now) || len === null) continue
    const elapsed = len - (window.resetsAt - current.updated)
    const used = 100 - window.remaining
    if (elapsed >= MIN_PACE_SAMPLE && used > 0) rates[rateKey(window.group, window.scope)] = used / elapsed
  }
  return rates
}

// A scoped window falls back to its group's unscoped rate.
const rateOf = (window, rates) => rates[rateKey(window.group, window.scope)] ?? rates[rateKey(window.group, null)] ?? 0

// When the first watched window of an account running from `start` falls below its threshold (or, `toEmpty`,
// reaches 0), or null when none does before `end`. A window that resets first starts over full.
function runOut(clock, windows, start, end, rates, toEmpty) {
  const hits = []
  for (const window of windows) {
    const limit = threshold(clock, window.group)
    if (limit === null) continue
    const floor = toEmpty ? 0 : limit
    const pace = rateOf(window, rates)
    let current = window
    let time = start
    let hit = null
    while (time < end) {
      const headroom = current.remaining - floor
      if (headroom < 0) {
        hit = time
        break
      }
      if (!(pace > 0)) break
      const at = time + headroom / pace
      if (current.resetsAt == null || current.resetsAt > at) {
        hit = at
        break
      }
      const reset = current.resetsAt
      current = settled(current, reset)
      time = reset
    }
    if (hit !== null) hits.push(hit)
  }
  return hits.length ? Math.min(...hits) : null
}

// The windows of an account that ran from `start` to `stop`, and the resets on the way of windows that had run low by then.
function advance(clock, windows, start, stop, rates) {
  const refills = []
  const after = windows.map((window) => {
    let current = window
    let time = start
    while (current.resetsAt != null && current.resetsAt <= stop) {
      const reset = current.resetsAt
      const leftAtReset = current.remaining - rateOf(current, rates) * (reset - time)
      const limit = threshold(clock, current.group)
      if (limit !== null && leftAtReset <= limit + TOLERANCE) refills.push({ at: reset, group: current.group })
      current = settled(current, reset)
      time = reset
    }
    return { ...current, remaining: Math.max(0, current.remaining - rateOf(current, rates) * (stop - time)) }
  })
  return { after, refills }
}

// Clearly above the threshold: an account that just ran down sits at it, give or take floating-point dust, and grazr
// would move off it again at its next reading. Counting it as spent keeps two such accounts from handing over to each
// other forever at the same moment.
function hasHeadroom(clock, windows, time) {
  return windows.every((window) => {
    const limit = threshold(clock, window.group)
    return limit === null || settled(window, time).remaining > limit + TOLERANCE
  })
}

// The first account in rotation order, other than `leaving`, not blocked, with headroom at `time`.
function pick(clock, rotation, windows, time, leaving) {
  return rotation.find((account) => account.id !== leaving?.id && !isBlocked(account)
    && hasHeadroom(clock, windows.get(account.id), time)) ?? null
}

// The soonest moment any unblocked account has headroom again: when the last of its low windows resets. Null when none does.
function soonestHeadroom(clock, rotation, windows, time) {
  const candidates = []
  for (const account of rotation) {
    if (isBlocked(account)) continue
    const settledWindows = windows.get(account.id).map((w) => settled(w, time))
    if (hasHeadroom(clock, settledWindows, time)) {
      candidates.push(time)
      continue
    }
    const low = settledWindows.filter((w) => {
      const limit = threshold(clock, w.group)
      return limit !== null && w.remaining <= limit + TOLERANCE
    })
    const resets = low.map((w) => w.resetsAt).filter((r) => r != null)
    if (resets.length > 0 && resets.length === low.length) candidates.push(Math.max(...resets))
  }
  return candidates.length ? Math.min(...candidates) : null
}

// The minimum settled remaining over watched windows, rounded; null when none is watched.
function leastLeft(clock, windows, time) {
  const values = windows.filter((w) => watched(clock, w)).map((w) => Math.round(settled(w, time).remaining))
  return values.length ? Math.min(...values) : null
}

// Resets of a parked account's low windows after `start` and at or before `end`: only a window that ran low coming back is worth a mark.
function parkedRefills(clock, windows, accountId, start, end) {
  return windows.flatMap((w) => {
    const limit = threshold(clock, w.group)
    if (w.resetsAt == null || !(w.resetsAt > start) || !(w.resetsAt <= end) || limit === null || w.remaining > limit + TOLERANCE) return []
    return [{ kind: 'refill', at: w.resetsAt, account: accountId, group: w.group }]
  })
}

// In time order, with one refill per account, group and minute: a per-model week resets with the all-models one.
function distinct(events) {
  const kept = []
  for (const event of [...events].sort((x, y) => x.at - y.at)) {
    const duplicate = event.kind === 'refill' && kept.some((other) => other.kind === 'refill'
      && other.account === event.account && other.group === event.group && Math.abs(other.at - event.at) < 60)
    if (!duplicate) kept.push(event)
  }
  return kept
}

// grazr's rotation projected from `now` to `now + horizon`, at the active account's current pace.
// Parked accounts are taken not to drain: other machines' use is not visible here.
export function project(clock, now, horizon) {
  const end = now + horizon
  const rotation = clock.accounts.map((account) => ({
    ...account,
    windows: account.windows.filter((w) => clock.modelLimits || w.scope === null || w.scope === undefined),
  }))
  const rates = burnRates(clock, rotation, now)
  const windows = new Map(rotation.map((account) => [account.id, account.windows.map(projected)]))
  const stretches = []
  const events = []
  let time = now
  let running = rotation.find((a) => clock.active !== null && a.id === clock.active) ?? pick(clock, rotation, windows, now, null)
  // Zero-length hand-overs add no stretch, so the steps need a bound of their own.
  let steps = 0

  while (time < end && stretches.length < MAX_STRETCHES && steps < 4 * MAX_STRETCHES) {
    steps += 1
    if (running === null) {
      const until = Math.min(soonestHeadroom(clock, rotation, windows, time) ?? end, end)
      if (until > time) stretches.push({ account: null, from: time, to: until, leftAtStart: null, leftAtEnd: null })
      time = until
      if (!(time < end)) break
      const next = pick(clock, rotation, windows, time, null)
      if (next === null) break
      events.push({ kind: 'swap', at: time, to: next.id })
      running = next
      continue
    }
    const parked = windows.get(running.id)
    events.push(...parkedRefills(clock, parked, running.id, now, time))
    const current = parked.map((w) => settled(w, time))
    const swapAt = Math.min(runOut(clock, current, time, end, rates, false) ?? end, end)
    const next = swapAt < end ? pick(clock, rotation, windows, swapAt, running) : null
    // With nowhere to go grazr stays, and the account runs until it is empty.
    const stop = next === null && swapAt < end
      ? Math.min(runOut(clock, current, time, end, rates, true) ?? end, end)
      : swapAt
    const { after, refills } = advance(clock, current, time, stop, rates)
    windows.set(running.id, after)
    events.push(...refills.map((r) => ({ kind: 'refill', at: r.at, account: running.id, group: r.group })))
    if (stop > time) {
      stretches.push({
        account: running.id, from: time, to: stop,
        leftAtStart: leastLeft(clock, current, time), leftAtEnd: leastLeft(clock, after, stop),
      })
    }
    time = stop
    if (!(time < end)) break
    if (next !== null) events.push({ kind: 'swap', at: time, to: next.id })
    running = next
  }
  // Accounts that sit parked to the end refill on schedule too.
  for (const account of rotation) {
    events.push(...parkedRefills(clock, windows.get(account.id), account.id, now, end - 1))
  }
  return { stretches, events: distinct(events) }
}

// The clock face. One SVG in the dial's 220 box: a 24-hour ring (midnight at the top) or a 7-day ring (Monday at the top),
// the stretches of the projection on it, swaps as ticks, refills as numbered dots, the hand at now and the centre text.

export const HORIZON = { session: 86400, weekly: 604800 }
const CENTRE = 110
const RING_R = 80
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const CENTRE_Y = {
  session: { time: 98, name: 118, runs: 132, then: 146 },
  weekly: { time: 92, day: 106, name: 122, runs: 136, then: 150 },
}

export function escapeText(s) {
  return text(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// One formatter per zone (the browser's when `timeZone` is undefined), built once, as the face asks for a moment many times.
const formatters = new Map()
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }))
  }
  return formatters.get(timeZone)
}

// Local calendar and clock parts of a moment in a zone. The weekday comes from the calendar date (Date.UTC's day, so
// no locale name is parsed), with ISO index 0 for Monday.
function localParts(seconds, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(seconds * 1000))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return {
    weekday: (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7,
    day: `${year}-${month}-${day}`,
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

const two = (n) => String(n).padStart(2, '0')
const clockTime = (p) => `${two(p.hour)}:${two(p.minute)}`

// The fraction of a turn from 12 o'clock: the local time of day on the 24-hour face, the weekday and time on the 7-day face.
export function turn(seconds, span, timeZone) {
  const p = localParts(seconds, timeZone)
  const day = p.hour * 3600 + p.minute * 60 + p.second
  return span === 'weekly' ? (p.weekday * 86400 + day) / HORIZON.weekly : day / HORIZON.session
}

// `HH:MM` on the same local day as `now`, otherwise `Wed 14:00`.
export function timeLabel(seconds, now, timeZone) {
  const p = localParts(seconds, timeZone)
  if (p.day === localParts(now, timeZone).day) return clockTime(p)
  return `${WEEKDAY_SHORT[p.weekday]} ${clockTime(p)}`
}

const polarSegment = (r1, r2, deg) => {
  const [x1, y1] = polar(CENTRE, CENTRE, r1, deg)
  const [x2, y2] = polar(CENTRE, CENTRE, r2, deg)
  return `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`
}

// One centre line, fitted to the inner circle at its y; the full text stays in a title.
function centreLine(cls, s, y, size, extra = '') {
  const full = escapeText(s)
  const fitted = escapeText(fitText(s, { y, size }))
  return `<text class="${cls}" x="${CENTRE}" y="${y}" font-size="${size}" text-anchor="middle"${extra}><title>${full}</title>${fitted}</text>`
}

// The face's centre: the time, the weekday on the 7-day face, then what runs now, when it ends and what follows.
function centreText(projection, { now, span, timeZone, nameOf, acctClass, end }) {
  const y = CENTRE_Y[span === 'weekly' ? 'weekly' : 'session']
  const lines = []
  const first = projection.stretches[0]
  const next = projection.stretches[1]
  lines.push(centreLine('clock-time', clockTime(localParts(now, timeZone)), y.time, 20, ' font-weight="bold"'))
  if (span === 'weekly') {
    lines.push(centreLine('clock-day', WEEKDAY_LONG[localParts(now, timeZone).weekday], y.day, 10))
  }
  if (!first) {
    lines.push(centreLine('clock-runs', 'no projection yet', y.name, 10))
  } else if (first.account === null) {
    // A gap that reaches the horizon has no end to name, so it says so rather than a time.
    const gap = first.to >= end ? 'nothing to run' : `nothing until ${timeLabel(first.to, now, timeZone)}`
    lines.push(centreLine('clock-gap', gap, y.name, 10))
  } else {
    lines.push(centreLine(`clock-name ${acctClass(first.account)}`, nameOf(first.account), y.name, 10, ' font-weight="bold"'))
    const runs = first.to >= end ? `runs all ${span === 'weekly' ? 'week' : 'day'}` : `runs until ~${timeLabel(first.to, now, timeZone)}`
    lines.push(centreLine('clock-runs', runs, y.runs, 10))
  }
  if (next && next.account === null) {
    lines.push(centreLine('clock-then gap', 'then nothing', y.then, 10))
  } else if (next) {
    lines.push(centreLine('clock-then', `then ${nameOf(next.account)}`, y.then, 10))
  }
  return lines
}

// The clock face for `clock` at `now`: `span` is 'session' (24 hours) or 'weekly' (7 days).
export function clockSvg(clock, { now, span, timeZone }) {
  const weekly = span === 'weekly'
  const horizon = HORIZON[weekly ? 'weekly' : 'session']
  const end = now + horizon
  const projection = project(clock, now, horizon)
  const accounts = clock.accounts ?? []
  const indexOf = (id) => accounts.find((a) => a.id === id)?.index ?? 1
  const nameOf = (id) => accounts.find((a) => a.id === id)?.name ?? String(id)
  const acctClass = (id) => `acct-${((indexOf(id) - 1) % 5) + 1}`
  const angle = (seconds) => turn(seconds, span, timeZone) * 360

  const count = weekly ? 7 : 24
  const ticks = Array.from({ length: count }, (_, i) => {
    const major = weekly || i % 6 === 0
    const deg = (i / count) * 360
    return `<line class="clock-tick${major ? ' major' : ''}" ${polarSegment(67, 71, deg)} stroke-width="${major ? 1.5 : 0.75}"/>`
  })
  const labels = weekly
    ? WEEKDAY_SHORT.map((d, i) => [d, ((i + 0.5) / 7) * 360])
    : [['00', 0], ['06', 90], ['12', 180], ['18', 270]]
  const labelMarks = labels.map(([label, deg]) => {
    const [x, y] = polar(CENTRE, CENTRE, 102, deg)
    return `<text class="clock-label" x="${x}" y="${y}" font-size="9" text-anchor="middle" dominant-baseline="central">${label}</text>`
  })

  // A stretch runs from its start's angle to its end's. A stretch that reaches the horizon ends at now's own angle a turn on: a DST
  // day is not 24 hours of ring, so its end would otherwise leave a gap or overlap. Any other stretch gets a turn added when it
  // has gone round: one longer than half the horizon that ends at or behind its start, or one that steps back by more than half
  // a turn (across midnight or Monday). A short step back, as across the repeated hour of a fall-back day, adds nothing and the
  // arc clamp draws it as a sliver.
  const stretches = projection.stretches.map((s) => {
    const start = angle(s.from)
    const back = angle(s.to) - start
    const long = s.to - s.from > horizon / 2
    const wraps = long ? back <= 0 : back < -180
    const sweepEnd = s.to >= end ? angle(now) + 360 : angle(s.to) + (wraps ? 360 : 0)
    const klass = s.account === null ? 'stretch stretch-gap' : `stretch ${acctClass(s.account)}`
    const d = arcPath(CENTRE, CENTRE, RING_R, start, sweepEnd)
    return `<path class="${klass}" fill="none" stroke-width="14" d="${d}"/>`
  })

  const events = projection.events.map((e) => {
    const deg = angle(e.at)
    if (e.kind === 'swap') {
      return `<line class="clock-swap" ${polarSegment(71, 91, deg)}/>`
    }
    const [x, y] = polar(CENTRE, CENTRE, 91, deg)
    const label = indexOf(e.account)
    return `<circle class="clock-refill ${acctClass(e.account)}" cx="${x}" cy="${y}" r="5.5"/>`
      + `<text class="clock-refill-num" x="${x}" y="${y}" font-size="7" font-weight="bold" text-anchor="middle" dominant-baseline="central">${label}</text>`
  })

  const hand = `<line class="clock-hand" ${polarSegment(65, 95, angle(now))} stroke-width="2.5" stroke-linecap="round"/>`
  const centre = centreText(projection, { now, span, timeZone, nameOf, acctClass, end })

  return `<svg viewBox="0 0 220 220">`
    + `<circle class="clock-face" cx="${CENTRE}" cy="${CENTRE}" r="${RING_R}" fill="none" stroke-width="14"/>`
    + ticks.join('') + labelMarks.join('') + stretches.join('') + events.join('') + hand + centre.join('')
    + `</svg>`
}
