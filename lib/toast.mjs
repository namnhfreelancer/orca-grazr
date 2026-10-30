export const TITLE_MAX = 120
export const BODY_MAX = 1000

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function clamp(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function toast(hostName, title, body = '') {
  return {
    title: clamp(`${hostName}: ${title}`, TITLE_MAX),
    body: clamp(body, BODY_MAX),
  }
}

// Each usage figure is optional, so a partial report from an older engine still renders.
function usageParts(snapshot) {
  const entries = Array.isArray(snapshot) ? snapshot : []
  const parts = []
  const session = entries.find((e) => e?.kind === 'session')
  const weekly = entries.find((e) => e?.group === 'weekly')
  if (typeof session?.remaining === 'number') parts.push(`S:${Math.round(session.remaining)}%`)
  if (typeof weekly?.remaining === 'number') parts.push(`W:${Math.round(weekly.remaining)}%`)
  return parts
}

function accountLine(account, activeId) {
  const isActive = activeId !== undefined && account.id === activeId
  return [
    isActive ? '*' : null,
    account.name ?? '?',
    ...usageParts(account.snapshot),
    account.parked ? '(parked)' : null,
    typeof account.blocked === 'string' && account.blocked ? `blocked: ${account.blocked}` : null,
  ].filter(Boolean).join(' ')
}

// Named accounts come first in the engine's rotation order, then any unordered ones.
function orderedAccounts(report) {
  const accounts = (Array.isArray(report.accounts) ? report.accounts : []).filter(isPlainObject)
  const order = Array.isArray(report.order) ? report.order : []
  const ordered = order.map((name) => accounts.find((a) => a.name === name)).filter(Boolean)
  return [...ordered, ...accounts.filter((a) => !ordered.includes(a))]
}

function statusLines(report) {
  const lines = []
  if (typeof report.settings?.enabled === 'boolean') {
    lines.push(`rotation ${report.settings.enabled ? 'on' : 'off'}`)
  }
  const activeId = report.active?.id
  for (const account of orderedAccounts(report)) {
    lines.push(accountLine(account, activeId))
  }
  const foreign = report.connection?.foreign?.statusline
  if (foreign) lines.push(`foreign statusLine: ${foreign}`)
  return lines
}

export function formatStatus(hostName, report) {
  const r = isPlainObject(report) ? report : {}
  return toast(hostName, r.active?.name ?? 'no account', statusLines(r).join('\n'))
}

// The engine's own line is shown as written; any other failure is labelled with its kind.
export function failureBody(failure) {
  return failure.kind === 'engine' ? failure.detail : `${failure.kind}: ${failure.detail}`
}

export function formatFailure(hostName, failure, command) {
  return toast(hostName, `${command} failed`, failureBody(failure))
}
