// The Orca accounts mode: grazr rotates the Claude account Orca launches with (Settings › AI Provider Accounts)
// instead of the System default ~/.claude login. Orca reads each account's usage and switches accounts itself, so
// nothing is installed on any host: every call is an Orca runtime RPC (accounts.list, accounts.selectClaude), made
// through Orca's own CLI client, on this Mac or on a paired environment.
//
// The runner here answers the same subcommands the engine does (status --json, swap, refresh, set ENABLED,
// notices-drain, install, uninstall), with the same result shapes, so the panel, the drain loop and the commands
// work unchanged in either mode.
import { fileURLToPath } from 'node:url'
import { ok } from './runner.mjs'
import { nextAccount, shortfallOf } from './panel-data.mjs'
import { createSessionMover } from './orca-session-mover.mjs'
import { createChatContinuer } from './orca-chat-continue.mjs'

export const ORCA_ACCOUNTS_MODE = 'orca-accounts'
export const ENGINE_MODE = 'engine'

const RPC_HELPER = fileURLToPath(new URL('./orca-rpc.cjs', import.meta.url))
const ENVIRONMENT_CACHE_MS = 60000

// Storage keys, each an object keyed by host name.
const ROTATION_KEY = 'orcaRotation'
const LAST_ROTATION_KEY = 'orcaLastRotation'
const STUCK_KEY = 'orcaStuck'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

export const isOrcaMode = (settings) => settings.mode === ORCA_ACCOUNTS_MODE

export function orcaBinaries(settings) {
  const app = settings.orcaApp.replace(/\/+$/, '')
  return {
    electron: `${app}/Contents/MacOS/Orca`,
    client: `${app}/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js`,
  }
}

// Runtime errors that mean the environment could not be reached, as ssh's exit 255 does in the engine mode.
const UNREACHABLE = new Set(['remote_runtime_unavailable', 'runtime_unavailable', 'not_running', 'runtime_not_running'])

// One RPC, never rejecting: { ok, result } or { ok: false, failure } with the kinds describeFailure uses.
export async function orcaRpc({ settings, exec }, host, method, params = {}, { timeoutMs = 30000 } = {}) {
  const { electron, client } = orcaBinaries(settings)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', GRAZR_RPC_TIMEOUT_MS: String(Math.max(1000, timeoutMs - 1000)) }
  // The worker may run inside an Orca terminal that names another environment or pairing; only the host's own counts.
  delete env.ORCA_ENVIRONMENT
  delete env.ORCA_PAIRING_CODE
  delete env.ORCA_REMOTE_PAIRING
  delete env.NODE_OPTIONS
  if (isString(host.orcaEnvironment) && host.orcaEnvironment !== '') env.ORCA_ENVIRONMENT = host.orcaEnvironment
  const result = await exec([electron, RPC_HELPER, client, method, JSON.stringify(params)], { env, timeoutMs })
  if (result.timedOut) return { ok: false, failure: { kind: 'timeout', detail: `timed out after ${timeoutMs / 1000}s` } }
  if (result.spawnError) {
    const kind = result.spawnError.code === 'ENOENT' ? 'missing-binary' : 'exit'
    return { ok: false, failure: { kind, detail: `could not run ${electron}: ${result.spawnError.message}` } }
  }
  let reply = null
  try {
    reply = JSON.parse((result.stdout ?? '').trim().split('\n').at(-1) ?? '')
  } catch {
    reply = null
  }
  if (ok(result) && reply?.ok === true) return { ok: true, result: reply.result }
  const code = reply?.error?.code ?? null
  const message = reply?.error?.message ?? ((result.stderr ?? '').trim().split('\n').at(-1) || `exit ${result.code}`)
  const where = host.orcaEnvironment ? ` (${host.orcaEnvironment})` : ''
  if (UNREACHABLE.has(code)) return { ok: false, failure: { kind: 'unreachable', detail: `${message}${where}` } }
  return { ok: false, failure: { kind: 'engine', detail: message } }
}

// The hosts of the Orca accounts mode: this Mac, then each paired environment the settings allow, in Orca's order.
// The environment list is read through the Orca CLI at most once a minute; a failed read keeps the last good one.
export function createOrcaHosts({ orcaCall, now = Date.now, log = () => {} }) {
  let cache = null
  async function environments(settings) {
    if (cache && now() - cache.at < ENVIRONMENT_CACHE_MS) return cache.names
    const listed = await orcaCall(settings, ['environment', 'list'])
    if (!listed.ok) {
      log(`grazr: orca environment list failed: ${listed.message}`)
      return cache?.names ?? []
    }
    const list = Array.isArray(listed.result?.environments) ? listed.result.environments : []
    const names = list.filter((e) => isObject(e) && isString(e.name) && e.name !== '').map((e) => e.name)
    cache = { at: now(), names }
    return names
  }

  return async function hostsFor(settings) {
    const wanted = settings.orcaAccounts.environments
    const names = wanted === 'none' ? [] : await environments(settings)
    const allowed = Array.isArray(wanted) ? names.filter((n) => wanted.includes(n)) : names
    const local = settings.orcaAccounts.localName
    const base = { ssh: null, python: 'python3', notifier: 'queue', forceInstall: null }
    return [
      { ...base, name: local, orcaEnvironment: null },
      ...allowed.filter((n) => n !== local).map((name) => ({ ...base, name, orcaEnvironment: name })),
    ]
  }
}

const iso = (ms) => (isNumber(ms) ? new Date(ms).toISOString() : null)
// Orca derives each reset time from the time it answers, so it moves by milliseconds between reads. Rounded to the
// minute, an unchanged window reads the same, and the panel is not rewritten (which would reload the plugin) for it.
const MINUTE = 60000
const resetIso = (ms) => (isNumber(ms) ? iso(Math.round(ms / MINUTE) * MINUTE) : null)

// Orca's usage windows as the engine's snapshot entries: remaining percent and reset time per group.
function snapshotOf(rateLimits) {
  if (!isObject(rateLimits)) return null
  const entries = []
  for (const [key, kind, group] of [['session', 'session', 'session'], ['weekly', 'weekly_all', 'weekly']]) {
    const w = rateLimits[key]
    if (isObject(w) && isNumber(w.usedPercent)) {
      entries.push({ kind, scope: null, group, remaining: Math.max(0, 100 - w.usedPercent), resets_at: resetIso(w.resetsAt) })
    }
  }
  return entries.length > 0 ? entries : null
}

const blockedOf = (account) => (account.needsSignIn === true ? 'sign in again in Orca › AI Provider Accounts' : null)

// accounts.list as the engine's status report. Every account Orca manages is in the rotation, in Orca's order; the
// active one is the account new Claude launches use. An account whose usage Orca has not read yet has no snapshot.
export function reportFrom(listed, { thresholds, enabled, lastRotation = null }) {
  const claude = isObject(listed?.claude) ? listed.claude : {}
  const limits = isObject(listed?.rateLimits) ? listed.rateLimits : {}
  const accounts = Array.isArray(claude.accounts) ? claude.accounts.filter((a) => isObject(a) && isString(a.id)) : []
  const activeId = isString(claude.activeAccountId) ? claude.activeAccountId : null
  const inactive = new Map((Array.isArray(limits.inactiveClaudeAccounts) ? limits.inactiveClaudeAccounts : [])
    .filter((e) => isObject(e) && isString(e.accountId))
    .map((e) => [e.accountId, e]))
  const nameOf = (a) => (isString(a.email) && a.email !== '' ? a.email : a.id)
  const active = accounts.find((a) => a.id === activeId) ?? null
  return {
    installed: true,
    connection: { statusline: true, failure_hook: true, foreign: { statusline: false, failure_hook: false } },
    active: active ? { id: active.id, name: nameOf(active), enrolled: true, in_order: true } : null,
    accounts: accounts.map((a) => {
      const usage = a.id === activeId ? limits.claude : inactive.get(a.id)?.rateLimits
      const updated = a.id === activeId ? limits.claude?.updatedAt : inactive.get(a.id)?.updatedAt
      return {
        id: a.id,
        name: nameOf(a),
        email: isString(a.email) ? a.email : null,
        organization: isString(a.organizationName) ? a.organizationName : null,
        plan: null,
        ultra: false,
        parked: a.id !== activeId,
        snapshot: snapshotOf(usage),
        blocked: blockedOf(a),
        in_order: true,
        first_reading_due: null,
        updated: iso(updated),
      }
    }),
    order: [],
    settings: {
      thresholds: { ...thresholds },
      enabled,
      dry_run: false,
      model_limits: false,
      parked_poll_minutes: null,
      pinned_rotation: 'exclude',
      ultra_no_session: false,
      config_path: 'Orca › Settings › AI Provider Accounts',
      state_dir: null,
      notifier: 'queue',
    },
    blocked: {},
    changed_at: lastRotation?.at ?? null,
    last_rotation: lastRotation,
    last_reported: null,
    managed_profile: null,
    version: null,
  }
}

const percent = (n) => `${Math.round(n)}%`
const windowLabel = (group) => (group === 'session' ? '5h' : 'week')

// The runner of the Orca accounts mode, with the engine runner's interface. storage is the plugin's own storage.
export function createOrcaRunner({ settings, exec, storage, now = Date.now, sleep, log = () => {} }) {
  const rpc = (host, method, params, timeoutMs) => orcaRpc({ settings, exec }, host, method, params, { timeoutMs })
  const thresholds = settings.orcaAccounts.thresholds
  const mover = createSessionMover({ rpc, storage, now, ...(sleep ? { sleep } : {}), log })
  const chats = createChatContinuer({ settings, exec, storage, now, log })

  async function readMap(key) {
    try {
      const value = await storage.get(key)
      return isObject(value) ? value : {}
    } catch (err) {
      log(`grazr: could not read ${key}: ${err?.message ?? err}`)
      return {}
    }
  }
  async function writeEntry(key, hostName, value) {
    const map = await readMap(key)
    if (value === undefined) delete map[hostName]
    else map[hostName] = value
    await storage.set(key, map)
  }
  const rotationOn = async (h) => (await readMap(ROTATION_KEY))[h.name] !== false

  async function report(h, timeoutMs) {
    const listed = await rpc(h, 'accounts.list', { refreshUsage: true }, timeoutMs)
    if (!listed.ok) return listed
    const value = reportFrom(listed.result, {
      thresholds,
      enabled: await rotationOn(h),
      lastRotation: (await readMap(LAST_ROTATION_KEY))[h.name] ?? null,
    })
    return { ok: true, value }
  }

  async function select(h, account, timeoutMs) {
    const selected = await rpc(h, 'accounts.selectClaude', { accountId: account.id }, timeoutMs)
    if (selected.ok) await writeEntry(LAST_ROTATION_KEY, h.name, { to: account.id, at: now() / 1000 })
    return selected
  }

  const findAccount = (value, wanted) => value.accounts.find((a) => a.id === wanted || a.name === wanted || a.email === wanted) ?? null

  // The engine's results: runJson gives { ok, value }, runLines gives { ok, lines }; failures carry { failure }.
  const done = (lines) => ({ ok: true, lines })
  const failed = (failure) => ({ ok: false, lines: [], failure })
  const refusal = (detail) => failed({ kind: 'engine', detail })

  async function swap(h, wanted, timeoutMs) {
    const current = await report(h, timeoutMs)
    if (!current.ok) return failed(current.failure)
    const value = current.value
    const target = wanted ? findAccount(value, wanted) : nextAccount(value, new Date(now()))
    if (!target) return refusal(wanted ? `no Orca account named ${wanted}` : 'Nothing to swap to: every other account is below its threshold or needs a sign-in')
    if (target.id === value.active?.id) return done([`Already on ${target.name}`])
    if (target.blocked) return refusal(`${target.name}: ${target.blocked}`)
    const selected = await select(h, target, timeoutMs)
    if (!selected.ok) return failed(selected.failure)
    return done([`Swapped ${value.active?.name ?? 'no account'} → ${target.name}`])
  }

  // One rotation decision: swap away from an active account below a threshold. Resolves to { lines, activeId }.
  // With nothing to swap to, the first tick says so once; the notice comes back after the account recovers.
  // limitHit: a chat or terminal on the active account just stopped at a usage limit, which swaps whatever Orca's
  // reading says (it can trail the limit by minutes).
  async function rotateOnce(h, value, timeoutMs, { limitHit = false } = {}) {
    const at = new Date(now())
    const active = value.accounts.find((a) => a.id === value.active?.id)
    const short = active ? shortfallOf(active.snapshot, thresholds, at) : null
    if (!active || (!short && !limitHit)) {
      if ((await readMap(STUCK_KEY))[h.name]) await writeEntry(STUCK_KEY, h.name, undefined)
      return { ok: true, lines: [], activeId: active?.id ?? null }
    }
    const reason = short ? `${windowLabel(short.group)} ${percent(short.remaining)} left` : 'usage limit reached'
    const target = nextAccount(value, at)
    if (!target) {
      if ((await readMap(STUCK_KEY))[h.name]) return { ok: true, lines: [], activeId: active.id }
      await writeEntry(STUCK_KEY, h.name, true)
      return { ok: true, lines: [JSON.stringify({ title: 'grazr: no account to swap to', body: `${active.name} has ${reason}; every other Orca account is spent or needs a sign-in` })], activeId: active.id }
    }
    const selected = await select(h, target, timeoutMs)
    if (!selected.ok) return { ok: false, failure: selected.failure }
    await writeEntry(STUCK_KEY, h.name, undefined)
    log(`grazr: ${h.name}: ${active.name} (${reason}) → ${target.name}`)
    return { ok: true, lines: [JSON.stringify({ title: 'grazr: swapped', body: `${active.name} (${reason}) → ${target.name}` })], activeId: target.id }
  }

  // The drain tick, per host: find the sessions a usage limit stopped; rotate when rotation is on (at once when one of
  // them ran on the active account); move idle terminal sessions left on another account (restartSessions); and
  // continue the stopped chats on the selected account (continueChats), when it has headroom.
  async function rotate(h, timeoutMs) {
    const on = await rotationOn(h)
    const restarts = settings.orcaAccounts.restartSessions === 'restart'
    const continues = settings.orcaAccounts.continueChats === 'continue'
    if (!on && !restarts && !continues) return done([])
    const current = await report(h, timeoutMs)
    if (!current.ok) return failed(current.failure)
    const value = current.value
    const lines = []
    let activeId = value.active?.id ?? null
    const panes = restarts ? await mover.inspect(h, value, timeoutMs) : null
    const cuts = continues ? (await chats.scan(h, timeoutMs)).cuts : []
    const limitHit = cuts.some((c) => c.accountId === activeId) || (panes ?? []).some((p) => p.limited && p.accountId === activeId)
    if (on) {
      const rotated = await rotateOnce(h, value, timeoutMs, { limitHit })
      if (!rotated.ok) return failed(rotated.failure)
      lines.push(...rotated.lines)
      activeId = rotated.activeId
    }
    const last = (await readMap(LAST_ROTATION_KEY))[h.name]
    const lastRotationAt = isNumber(last?.at) ? last.at * 1000 : null
    if (restarts) lines.push(...(await mover.move(h, value, { activeId, lastRotationAt, panes: panes ?? undefined, timeoutMs })))
    // A cut is continued only on another account than the one it stopped on, and only one not itself spent.
    const active = value.accounts.find((a) => a.id === activeId)
    const activeSpent = !active || shortfallOf(active.snapshot, thresholds, new Date(now())) !== null
    const movable = cuts.filter((c) => c.accountId && c.accountId !== activeId)
    if (continues && !activeSpent && movable.length > 0) lines.push(...(await chats.continueCuts(h, movable, active.name, timeoutMs)))
    return done(lines)
  }

  const NOTHING_TO_INSTALL = 'Orca accounts mode: nothing to install; Orca switches its own accounts'

  async function runLines(h, args, { timeoutMs = 20000 } = {}) {
    const [command, ...rest] = args
    switch (command) {
      case 'notices-drain':
        return rotate(h, timeoutMs)
      case 'swap':
        return swap(h, rest[0], timeoutMs)
      case 'refresh': {
        const current = await report(h, timeoutMs)
        return current.ok ? done(['Usage refreshed from Orca']) : failed(current.failure)
      }
      case 'set':
        if (rest[0] === 'ENABLED' && (rest[1] === '0' || rest[1] === '1')) {
          await writeEntry(ROTATION_KEY, h.name, rest[1] === '1')
          return done([`rotation ${rest[1] === '1' ? 'on' : 'off'}`])
        }
        return refusal(`Orca accounts mode has no setting ${rest[0] ?? ''}`.trim())
      case 'install':
      case 'uninstall':
        return done([NOTHING_TO_INSTALL])
      default:
        return refusal(`${command} is not available in the Orca accounts mode`)
    }
  }

  async function runJson(h, args, { timeoutMs = 20000 } = {}) {
    if (args[0] === 'status') return report(h, timeoutMs)
    const result = await runLines(h, args, { timeoutMs })
    return result.ok ? { ok: true, value: { lines: result.lines } } : result
  }

  // Nothing is typed into a terminal in this mode; the text says where to look instead.
  const command = (h, args) => ({ argv: ['echo', `grazr (Orca accounts) on ${h.name}: ${args.join(' ')}`], env: process.env })

  return { runJson, runLines, command }
}
