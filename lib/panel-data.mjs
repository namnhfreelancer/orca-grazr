import { currentTarget, DEFAULT_SETTINGS } from './hosts.mjs'
import { clamp } from './toast.mjs'

// The centre hint must fit beside the ring's centre text at size 10.
const HINT_MAX = 24

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

// A report that is not an object (an old or broken engine) renders as an empty one.
const reportOf = (value) => (isPlainObject(value) ? value : {})

// A missing threshold never marks an account spent, so the default is zero.
function thresholdsOf(report) {
  const t = isPlainObject(report.settings?.thresholds) ? report.settings.thresholds : {}
  return { session: isNumber(t.session) ? t.session : 0, weekly: isNumber(t.weekly) ? t.weekly : 0 }
}

// The engine's _live: an entry whose reset is at or before now has run out and counts as absent.
// A missing or unreadable reset time stays live, as the engine keeps it.
function isLive(entry, now) {
  if (!isString(entry.resets_at)) return true
  const at = Date.parse(entry.resets_at)
  return Number.isNaN(at) || at > now.getTime()
}

// The window a view shows: the account-wide entry of its group (scope null, as the engine reports it), if still live.
// A per-model weekly entry is never the one shown.
export function windowOf(snapshot, view, now = new Date()) {
  const entries = Array.isArray(snapshot) ? snapshot : []
  const entry = entries.find((e) => isPlainObject(e) && e.group === view && e.scope === null && isLive(e, now))
  if (!entry || !isNumber(entry.remaining)) return null
  return { remaining: entry.remaining, resets_at: isString(entry.resets_at) ? entry.resets_at : null }
}

// Per-model weekly windows count only when the engine reports model limits on; with them off the engine drops them.
const modelLimitsOf = (report) => report.settings?.model_limits === true

// The engine's shortfall: the first live entry whose group has a threshold and that sits below it.
// Scoped (per-model) entries count only when modelLimits is on, as the engine's _bound keeps them only then.
// An account with a shortfall is spent, whichever of its windows the view shows.
export function shortfallOf(snapshot, thresholds, now = new Date(), modelLimits = false) {
  if (!Array.isArray(snapshot)) return null
  return snapshot.find((e) => isPlainObject(e) && isString(e.group) && Object.hasOwn(thresholds, e.group)
    && (e.scope === null || modelLimits) && isNumber(e.remaining) && e.remaining < thresholds[e.group] && isLive(e, now)) ?? null
}

// Named accounts come first in the engine's rotation order, then any unordered ones.
// A name in order with no record becomes a placeholder, so the panel can say not enrolled.
export function orderedAccounts(report) {
  const accounts = (Array.isArray(report.accounts) ? report.accounts : []).filter(isPlainObject)
  const order = Array.isArray(report.order) ? report.order.filter(isString) : []
  const ordered = order.map((name) => accounts.find((a) => a.name === name) ?? { name, missing: true })
  return [...ordered, ...accounts.filter((a) => !order.includes(a.name))]
}

// The active record, or null when nobody is logged in or the active one is not in the list.
function activeAccount(report) {
  const id = report.active?.id
  if (id === undefined || id === null) return null
  return orderedAccounts(report).find((a) => !a.missing && a.id === id) ?? null
}

const isActiveRecord = (account, report) => {
  const active = activeAccount(report)
  return active !== null && account.id !== undefined && account.id === active.id
}

// Eligible for the engine's next_account: parked, not blocked, and no shortfall on any live window.
function eligible(account, thresholds, now, modelLimits) {
  if (account.missing || !account.parked || account.blocked) return false
  return shortfallOf(account.snapshot, thresholds, now, modelLimits) === null
}

// The engine's next_account: the first account in preference order that is not the active one and is eligible.
// There is no wrap from the active account. With an order set, only named accounts can be next.
export function nextAccount(report, now = new Date()) {
  const active = activeAccount(report)
  if (active === null) return null
  const order = Array.isArray(report.order) ? report.order.filter(isString) : []
  const thresholds = thresholdsOf(report)
  const modelLimits = modelLimitsOf(report)
  for (const candidate of orderedAccounts(report)) {
    if (candidate.id === active.id) continue
    if (order.length > 0 && !order.includes(candidate.name)) continue
    if (eligible(candidate, thresholds, now, modelLimits)) return candidate
  }
  return null
}

// The engine's reset time, shown in the given zone so tests can pin it.
function formatReset(iso, timeZone) {
  if (!isString(iso)) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  // h23 rather than hour12:false, which some engines render as 24:00 at midnight.
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
    .format(date)
}

export function rowState(account, report, view, { timeZone, now = new Date() } = {}) {
  if (account.missing) return { percent: null, status: 'not-enrolled', label: 'not enrolled' }
  const window = windowOf(account.snapshot, view, now)
  const percent = window ? Math.round(window.remaining) : null
  const reason = isString(account.blocked) && account.blocked ? account.blocked : null
  if (isActiveRecord(account, report)) {
    return { percent, status: 'active', label: reason ? `active · blocked: ${reason}` : 'active' }
  }
  // A blocked account cannot be rotated to, so it shows no percent whatever its snapshot says.
  if (reason) return { percent: null, status: 'blocked', label: `blocked: ${reason}` }
  const next = nextAccount(report, now)
  if (next !== null && account.id === next.id) return { percent, status: 'next', label: 'NEXT ▸' }
  // Spent on either window, so a row never reads ok while the other window is below its threshold.
  // The reset time shown is the binding window's.
  const binding = shortfallOf(account.snapshot, thresholdsOf(report), now, modelLimitsOf(report))
  if (binding) {
    const resets = formatReset(binding.resets_at, timeZone)
    return { percent, status: 'spent', label: resets ? `spent · resets ${resets}` : 'spent' }
  }
  if (!window) return { percent, status: 'unread', label: 'not read yet' }
  return { percent, status: 'ok', label: '' }
}

// The live weekly window of one model scope on an account, or null when it has none or it has run out.
function scopedWindow(account, scope, now) {
  if (!Array.isArray(account.snapshot)) return null
  const entry = account.snapshot.find((e) => isPlainObject(e) && e.group === 'weekly' && e.scope === scope && isLive(e, now))
  return entry && isNumber(entry.remaining) ? entry : null
}

// The list face's rule for a window's tone: spent at 2% or less, warning under the weekly threshold, else fine; none without a reading.
function windowTone(remaining, threshold) {
  if (remaining === null) return 'none'
  const left = Math.round(remaining)
  return left <= 2 ? 'spent' : left < threshold ? 'warning' : 'fine'
}

// The active account's live model windows, in the scope order; a scope it has no live window for is left out.
function centreModels(active, scopes, now, weeklyThreshold) {
  if (active === null || active.missing) return []
  return scopes.flatMap((scope) => {
    const entry = scopedWindow(active, scope, now)
    return entry ? [{ scope, left: Math.round(entry.remaining), tone: windowTone(entry.remaining, weeklyThreshold) }] : []
  })
}

// The weekly model scopes the rings draw: each distinct scope of a weekly entry, sorted by code unit, when model limits are on.
export function modelScopes(report) {
  if (!modelLimitsOf(report)) return []
  const scopes = new Set()
  for (const account of orderedAccounts(report)) {
    if (!Array.isArray(account.snapshot)) continue
    for (const e of account.snapshot) {
      if (isPlainObject(e) && e.group === 'weekly' && isString(e.scope)) scopes.add(e.scope)
    }
  }
  return [...scopes].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
}

// The centre reads one status for the active account, so its hint and tone cannot disagree.
// Tone: blocked outranks the rest; a shown window below its threshold is warning (amber); a shortfall on the other
// window alone is spent (red) while the shown window reads fine; no reading at all is none.
// The hint is cut to 24 characters so a long block reason stays inside the ring.
export function centre(report, view, { now = new Date(), models } = {}) {
  const active = activeAccount(report)
  const next = nextAccount(report, now)
  const nextName = next ? next.name : null
  // The model lines come only when the caller passes the scopes; they are the active account's live weekly windows.
  const withModels = (result) => (Array.isArray(models)
    ? { ...result, models: centreModels(active, models, now, thresholdsOf(report).weekly) }
    : result)
  if (active === null) {
    return withModels({ name: '—', percentText: '—', hint: 'no active login', nextName, tone: 'none' })
  }
  const window = windowOf(active.snapshot, view, now)
  const percentText = window ? `${Math.round(window.remaining)}% left` : '—'
  const thresholds = thresholdsOf(report)
  const blocked = isString(active.blocked) && active.blocked ? active.blocked : null
  const shortfall = shortfallOf(active.snapshot, thresholds, now, modelLimitsOf(report))
  const belowShown = window !== null && Object.hasOwn(thresholds, view) && window.remaining < thresholds[view]
  let tone = 'none'
  if (blocked) tone = 'blocked'
  else if (belowShown) tone = 'warning'
  else if (shortfall) tone = 'spent'
  else if (window) tone = 'fine'
  let hint = 'fine'
  if (blocked) hint = clamp(`blocked: ${blocked}`, HINT_MAX)
  else if (shortfall) hint = 'swaps next turn'
  else if (!window) hint = 'not read yet'
  return withModels({ name: active.name, percentText, hint, nextName, tone })
}

// Failures are checked first; a chip can only be one state, so a conflict outranks the on/off state.
// A host whose status line or hook is disconnected reports installed false, and nothing rotates there whatever the setting says.
export function hostChip({ result }) {
  if (!result?.ok) {
    return result?.failure?.kind === 'not-installed'
      ? { kind: 'not-installed', label: 'engine not installed' }
      : { kind: 'unreachable', label: 'unreachable' }
  }
  const report = reportOf(result.value)
  if (report.connection?.foreign?.statusline) return { kind: 'foreign', label: 'another grazr owns the status line' }
  if (report.managed_profile) return { kind: 'managed', label: 'managed profile' }
  if (report.installed === false) return { kind: 'not-connected', label: 'not connected' }
  return report.settings?.enabled === true
    ? { kind: 'on', label: 'rotation on' }
    : { kind: 'off', label: 'rotation off' }
}

// Segment state maps the row status, with the two states that carry no reading folded into unknown.
const SEGMENT_STATE = {
  active: 'active', next: 'next', spent: 'spent', blocked: 'blocked', ok: 'ok',
  unread: 'unknown', 'not-enrolled': 'unknown',
}

// The dial tooltip's tone, from the row status: the tone the row's own label is drawn in, none where there is no reading.
const TIP_TONE = {
  active: 'fine', ok: 'fine', next: 'warning', spent: 'spent', blocked: 'blocked', unread: 'none', 'not-enrolled': 'none',
}

// The swap threshold the report sets for this window, or null when the report sets none (the default zero would put the tick at the slice end).
function thresholdOf(report, view) {
  const t = isPlainObject(report.settings?.thresholds) ? report.settings.thresholds : {}
  return isNumber(t[view]) ? t[view] : null
}

function buildView(report, view, timeZone, now) {
  const accounts = orderedAccounts(report)
  const rows = []
  const segments = []
  // Only the weekly view has model rings; each scope lists every account's model window in the same order.
  const models = view === 'weekly' ? modelScopes(report) : []
  const thresholds = thresholdsOf(report)
  const modelLimits = modelLimitsOf(report)
  accounts.forEach((account, i) => {
    const state = rowState(account, report, view, { timeZone, now })
    const blocked = isString(account.blocked) && account.blocked ? account.blocked : null
    rows.push({
      index: i + 1,
      name: account.name,
      percent: state.percent,
      status: state.status,
      label: state.label,
      blocked,
      isActive: state.status === 'active',
      isNext: state.status === 'next',
    })
    const shown = account.missing ? null : windowOf(account.snapshot, view, now)
    // A blocked account shows no reading, as the main ring does; the active account keeps its own readings.
    const hidden = state.status === 'blocked'
    segments.push({
      index: i + 1,
      name: account.name,
      remaining: hidden ? null : (shown?.remaining ?? null),
      resets: formatReset(shown?.resets_at, timeZone),
      tone: TIP_TONE[state.status],
      state: SEGMENT_STATE[state.status],
      models: models.map((scope) => {
        const entry = hidden || account.missing ? null : scopedWindow(account, scope, now)
        const remaining = entry ? entry.remaining : null
        return { scope, remaining, resets: entry ? formatReset(entry.resets_at, timeZone) : null, tone: windowTone(remaining, thresholds.weekly) }
      }),
      // dimmed where grazr would not move in now: the active account, or one not blocked and not short on any live window.
      usable: state.status === 'active' || (!account.missing && blocked === null && shortfallOf(account.snapshot, thresholds, now, modelLimits) === null),
    })
  })
  return { centre: centre(report, view, { now, models }), threshold: thresholdOf(report, view), rows, segments, models }
}

// The clock's data: the rotation in order (named accounts, then the active one), each with its row index and the
// windows the projection needs. The page projects from this and the browser's own clock, so none of it is time-stamped.
// indexes maps an account name to its row number in buildView, so the clock's badges match the rows.
export function clockData(report, indexes) {
  const named = Array.isArray(report.order) ? report.order.filter(isString) : []
  const records = orderedAccounts(report).filter((a) => !a.missing)
  let rotation = records
  if (named.length > 0) {
    rotation = named.map((name) => records.find((a) => a.name === name)).filter((a) => a !== undefined)
    const active = activeAccount(report)
    if (active !== null && !named.includes(active.name)) rotation.push(active)
  }
  const modelLimits = modelLimitsOf(report)
  const thresholds = { session: thresholdOf(report, 'session'), weekly: thresholdOf(report, 'weekly') }
  const seconds = (iso) => {
    if (!isString(iso)) return null
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? null : ms / 1000
  }
  return {
    active: activeAccount(report)?.id ?? null,
    thresholds,
    modelLimits,
    accounts: rotation.map((account) => ({
      id: account.id,
      name: account.name,
      index: indexes.get(account.name),
      // A non-active account with no parked credential cannot be swapped to, so the clock treats it as blocked, as the dial does.
      blocked: (isString(account.blocked) && account.blocked !== '') || (!isActiveRecord(account, report) && account.parked !== true),
      // Only the active account's reading time is embedded: it is the only one burnRates reads, and the others move on every drain tick.
      updated: isActiveRecord(account, report) && isNumber(account.updated) ? account.updated : null,
      windows: (Array.isArray(account.snapshot) ? account.snapshot : [])
        .filter((e) => isPlainObject(e) && (e.group === 'session' || e.group === 'weekly') && isNumber(e.remaining)
          && (e.scope === null || modelLimits))
        .map((e) => ({
          group: e.group,
          scope: isString(e.scope) ? e.scope : null,
          remaining: e.remaining,
          resetsAt: seconds(e.resets_at),
        })),
    })),
  }
}

// The windows the list shows: session first, then the unscoped week, then scoped weeks by scope name (HerdrKit sortedWindows).
// A window whose reset has passed reads 100 (HerdrKit left(now:)); its tone follows GrazrStyle.tint.
function listWindows(account, thresholds, modelLimits, timeZone, now) {
  const rank = (e) => (e.group === 'session' ? 0 : e.scope === null ? 1 : 2)
  const entries = (Array.isArray(account.snapshot) ? account.snapshot : [])
    .filter((e) => isPlainObject(e) && (e.group === 'session' || e.group === 'weekly') && isNumber(e.remaining)
      && (e.scope === null || (modelLimits && isString(e.scope))))
    .sort((x, y) => rank(x) - rank(y) || (rank(x) === 2 ? (x.scope < y.scope ? -1 : x.scope > y.scope ? 1 : 0) : 0))
  return entries.map((e) => {
    const open = isLive(e, now)
    const left = open ? Math.round(e.remaining) : 100
    const tone = left <= 2 ? 'spent' : left < thresholds[e.group] ? 'warning' : 'fine'
    const label = e.group === 'session' ? '5h' : e.scope === null ? 'Week' : `${e.scope} week`
    let reset = ''
    if (isString(e.resets_at)) {
      const at = open ? formatReset(e.resets_at, timeZone) : null
      if (!open) reset = 'reset since'
      else if (at !== null) reset = `resets ${at}`
    }
    return { label, left, tone, reset }
  })
}

// HerdrKit's GrazrPlan.label: the plan's name, then the multiplier of the seat tier or the tier ("Max 20x", "Team 5x").
// A plan with no type, or no object at all, has no label.
const PLAN_NAMES = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' }
const PLAN_MULTIPLIER = (tier) => {
  if (!isString(tier)) return null
  const last = tier.split('_').filter(Boolean).pop()
  return last !== undefined && /^\d+x$/.test(last) ? last : null
}

export function planLabel(plan) {
  if (!isPlainObject(plan) || !isString(plan.type) || plan.type === '') return null
  const name = PLAN_NAMES[plan.type] ?? plan.type.replace(/^claude_/, '').split('_').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
  if (name === '') return null
  const multiplier = PLAN_MULTIPLIER(plan.seat_tier) ?? PLAN_MULTIPLIER(plan.tier)
  return multiplier === null ? name : `${name} ${multiplier}`
}

// The account's organization, with HerdrM's default `${name}'s Organization` hidden.
const organizationOf = (account) => {
  const org = account.organization
  return !isString(org) || org === '' || org === `${account.name}'s Organization` ? null : org
}

// The list face's data: one entry per account in rotation order, placeholders included, with the windows it shows.
export function listOf(report, { now = new Date(), timeZone } = {}) {
  const source = reportOf(report)
  const thresholds = thresholdsOf(source)
  const modelLimits = modelLimitsOf(source)
  return {
    accounts: orderedAccounts(source).map((account, i) => {
      const missing = account.missing === true
      const active = isActiveRecord(account, source)
      const blocked = isString(account.blocked) && account.blocked !== '' ? account.blocked : null
      let action = null
      if (!missing) action = blocked !== null ? 'reauth' : active ? null : account.parked === true ? 'switch' : 'reauth'
      return {
        name: account.name,
        index: i + 1,
        missing,
        active,
        blocked,
        listed: missing || account.in_order === true,
        plan: planLabel(account.plan),
        organization: organizationOf(account),
        updated: isNumber(account.updated) ? account.updated : null,
        action,
        windows: missing ? [] : listWindows(account, thresholds, modelLimits, timeZone, now),
      }
    }),
  }
}

// The installed engine's version against the one bundled with the plugin. A missing version is null and never outdated.
function engineOf(report, bundledVersion) {
  const installed = isString(report.version) && report.version.trim() !== '' ? report.version.trim() : null
  const bundled = isString(bundledVersion) && bundledVersion.trim() !== '' ? bundledVersion.trim() : null
  return { installed, bundled, outdated: installed !== null && bundled !== null && installed !== bundled }
}

// readAt is when the result was read; a result kept from an earlier run keeps that time, and otherwise it is now.
function buildHost({ host, result, readAt }, now, timeZone, bundledVersion) {
  const chip = hostChip({ result })
  const base = { name: host.name, ssh: host.ssh ?? null, chip }
  if (!result.ok) {
    return { ...base, reachable: false, enabled: false, engine: null, failure: failureOf(result.failure), thresholds: null, views: null, updatedAt: null, clock: null, list: null }
  }
  const report = reportOf(result.value)
  const indexes = new Map(orderedAccounts(report).map((a, i) => [a.name, i + 1]))
  return {
    ...base,
    reachable: true,
    enabled: report.settings?.enabled === true,
    engine: engineOf(report, bundledVersion),
    failure: null,
    thresholds: thresholdsOf(report),
    views: { session: buildView(report, 'session', timeZone, now), weekly: buildView(report, 'weekly', timeZone, now) },
    updatedAt: (readAt ?? now).toISOString(),
    clock: clockData(report, indexes),
    list: listOf(report, { now, timeZone }),
  }
}

// A timeout's detail names the budget it was cut to, which changes on every refresh and would rewrite the page each time.
function failureOf(failure) {
  if (!failure) return null
  return failure.kind === 'timeout' ? { ...failure, detail: 'timed out' } : failure
}

// The target host comes first; the others keep the order they were given in.
// bundledVersion is the version the plugin ships, or null when it could not be read.
export function buildPanelData({ settings, hosts, now = new Date(), timeZone, bundledVersion = null }) {
  const target = currentTarget(settings).name
  const entries = hosts.filter((entry) => entry.host.name === target)
  const others = hosts.filter((entry) => entry.host.name !== target)
  return {
    generatedAt: now.toISOString(),
    target,
    face: settings.panelFace ?? DEFAULT_SETTINGS.panelFace,
    view: settings.panelView ?? DEFAULT_SETTINGS.panelView,
    hosts: [...entries, ...others].map((entry) => buildHost(entry, now, timeZone, bundledVersion)),
  }
}
