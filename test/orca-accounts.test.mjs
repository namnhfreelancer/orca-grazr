import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettings } from '../lib/hosts.mjs'
import { createOrcaRunner, createOrcaHosts, orcaRpc, reportFrom } from '../lib/orca-accounts.mjs'
import { nextAccount } from '../lib/panel-data.mjs'

const NOW = Date.parse('2026-11-05T06:00:00Z')
const HOUR = 3600000
const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@example.com', organizationName: 'Org A' }
const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'b@example.com', organizationName: 'Org B' }
const C = { id: 'cccccccc-0000-4000-8000-000000000003', email: 'c@example.com', organizationName: 'Org C' }

const usage = (sessionUsed, weeklyUsed) => ({
  session: sessionUsed === null ? null : { usedPercent: sessionUsed, windowMinutes: 300, resetsAt: NOW + HOUR },
  weekly: weeklyUsed === null ? null : { usedPercent: weeklyUsed, windowMinutes: 10080, resetsAt: NOW + 48 * HOUR },
  updatedAt: NOW,
})

// accounts.list as Orca answers it: the active account's usage in rateLimits.claude, the others in inactiveClaudeAccounts.
function listed({ accounts = [A, B, C], active = A.id, usages = {} } = {}) {
  return {
    claude: { accounts, activeAccountId: active },
    rateLimits: {
      claude: usages[active] ?? usage(10, 10),
      inactiveClaudeAccounts: accounts.filter((a) => a.id !== active).map((a) => ({
        accountId: a.id,
        rateLimits: usages[a.id] ?? { session: null, weekly: null, status: 'error' },
        updatedAt: NOW,
      })),
    },
  }
}

// Answers the RPC helper's argv the way Orca does, per environment, and records every call.
function fakeOrca(byEnvironment) {
  const calls = []
  const exec = async (argv, { env }) => {
    const [, , , method, raw] = argv
    const where = env.ORCA_ENVIRONMENT ?? 'local'
    const params = JSON.parse(raw)
    calls.push({ where, method, params })
    const state = byEnvironment[where]
    if (state === 'unreachable') {
      return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'remote_runtime_unavailable', message: 'Could not connect to the remote Orca runtime.' } }), stderr: '' }
    }
    if (method === 'accounts.list') return { code: 0, stdout: JSON.stringify({ ok: true, result: listed(state) }), stderr: '' }
    if (method === 'accounts.selectClaude') {
      state.active = params.accountId
      return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }
    }
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'method_not_found', message: method } }), stderr: '' }
  }
  return { exec, calls }
}

function fakeStorage(initial = {}) {
  const data = structuredClone(initial)
  return { data, get: async (key) => data[key], set: async (key, value) => { data[key] = structuredClone(value) } }
}

const settings = (over = {}) => mergeSettings({ mode: 'orca-accounts', ...over })
const MAC = { name: 'mac', ssh: null, orcaEnvironment: null, notifier: 'queue' }
const VPS = { name: 'VPS', ssh: null, orcaEnvironment: 'VPS', notifier: 'queue' }

function runnerWith(byEnvironment, storage = fakeStorage(), over = {}) {
  const orca = fakeOrca(byEnvironment)
  const runner = createOrcaRunner({ settings: settings(over), exec: orca.exec, storage, now: () => NOW })
  return { runner, orca, storage }
}

test('the Orca accounts mode is the default, with its own thresholds', () => {
  const s = mergeSettings(undefined)
  assert.equal(s.mode, 'orca-accounts')
  assert.deepEqual(s.orcaAccounts, { thresholds: { session: 15, weekly: 10 }, environments: 'all', localName: 'mac' })
})

test('a bad orcaAccounts value falls back key by key', () => {
  const s = mergeSettings({ orcaAccounts: { thresholds: { session: 150, weekly: 20 }, environments: 7, localName: ' ' } })
  assert.deepEqual(s.orcaAccounts, { thresholds: { session: 15, weekly: 20 }, environments: 'all', localName: 'mac' })
  assert.equal(mergeSettings({ mode: 'other' }).mode, 'orca-accounts')
})

test('the report names accounts by email, in Orca order, with remaining percent per window', () => {
  const report = reportFrom(listed({ usages: { [A.id]: usage(40, 30), [B.id]: usage(100, 50) } }), { thresholds: { session: 15, weekly: 10 }, enabled: true })
  assert.deepEqual(report.active, { id: A.id, name: 'a@example.com', enrolled: true, in_order: true })
  assert.deepEqual(report.accounts.map((a) => a.name), ['a@example.com', 'b@example.com', 'c@example.com'])
  assert.deepEqual(report.accounts[0].snapshot.map((e) => [e.group, e.remaining]), [['session', 60], ['weekly', 70]])
  assert.deepEqual(report.accounts[1].snapshot.map((e) => [e.group, e.remaining]), [['session', 0], ['weekly', 50]])
  // An account whose usage Orca has not read yet has no snapshot, so it reads as not read yet, never as spent.
  assert.equal(report.accounts[2].snapshot, null)
  assert.equal(report.settings.enabled, true)
  // The account below the 5-hour threshold is skipped; the unread one is next.
  assert.equal(nextAccount(report, new Date(NOW)).id, C.id)
})

test('an account Orca says needs a sign-in is blocked and never next', () => {
  const report = reportFrom(listed({ accounts: [A, { ...B, needsSignIn: true }, C], usages: { [C.id]: usage(100, 0) } }), { thresholds: { session: 15, weekly: 10 }, enabled: true })
  assert.match(report.accounts[1].blocked, /sign in again/)
  assert.equal(nextAccount(report, new Date(NOW)), null)
})

test('a drain tick swaps away from an active account below its threshold and reports it as a notice', async () => {
  const state = { active: A.id, usages: { [A.id]: usage(90, 20), [B.id]: usage(10, 10) } }
  const { runner, orca, storage } = runnerWith({ local: state })
  const result = await runner.runLines(MAC, ['notices-drain'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.lines.map((l) => JSON.parse(l)), [{ title: 'grazr: swapped', body: 'a@example.com (5h 10% left) → b@example.com' }])
  assert.deepEqual(orca.calls.at(-1), { where: 'local', method: 'accounts.selectClaude', params: { accountId: B.id } })
  assert.equal(state.active, B.id)
  assert.equal(storage.data.orcaLastRotation.mac.to, B.id)
})

test('a drain tick with headroom changes nothing', async () => {
  const { runner, orca } = runnerWith({ local: { active: A.id, usages: { [A.id]: usage(50, 50) } } })
  assert.deepEqual((await runner.runLines(MAC, ['notices-drain'])).lines, [])
  assert.equal(orca.calls.some((c) => c.method === 'accounts.selectClaude'), false)
})

test('with every other account spent, the tick says so once and selects nothing', async () => {
  const spent = usage(100, 100)
  const state = { active: A.id, usages: { [A.id]: usage(95, 0), [B.id]: spent, [C.id]: spent } }
  const { runner, orca } = runnerWith({ local: state })
  const first = await runner.runLines(MAC, ['notices-drain'])
  assert.equal(JSON.parse(first.lines[0]).title, 'grazr: no account to swap to')
  assert.deepEqual((await runner.runLines(MAC, ['notices-drain'])).lines, [])
  assert.equal(orca.calls.some((c) => c.method === 'accounts.selectClaude'), false)
})

test('rotation off for a host stops its drain from swapping, and the report says it is off', async () => {
  const state = { active: A.id, usages: { [A.id]: usage(99, 0) } }
  const { runner, orca, storage } = runnerWith({ local: state })
  assert.deepEqual((await runner.runLines(MAC, ['set', 'ENABLED', '0'])).lines, ['rotation off'])
  assert.deepEqual(storage.data.orcaRotation, { mac: false })
  assert.deepEqual((await runner.runLines(MAC, ['notices-drain'])).lines, [])
  assert.equal((await runner.runJson(MAC, ['status', '--json'])).value.settings.enabled, false)
  assert.equal(orca.calls.some((c) => c.method === 'accounts.selectClaude'), false)
})

test('a named swap selects that account on the host’s own environment', async () => {
  const local = { active: A.id }
  const vps = { active: A.id }
  const { runner, orca } = runnerWith({ local, VPS: vps })
  const result = await runner.runLines(VPS, ['swap', 'c@example.com'])
  assert.deepEqual(result.lines, ['Swapped a@example.com → c@example.com'])
  assert.equal(vps.active, C.id)
  assert.equal(local.active, A.id)
  assert.deepEqual(orca.calls.map((c) => c.where), ['VPS', 'VPS'])
})

test('an unknown account name is refused with the engine kind', async () => {
  const { runner } = runnerWith({ local: { active: A.id } })
  const result = await runner.runLines(MAC, ['swap', 'nobody@example.com'])
  assert.equal(result.ok, false)
  assert.deepEqual(result.failure, { kind: 'engine', detail: 'no Orca account named nobody@example.com' })
})

test('an environment Orca cannot reach fails as unreachable, naming it', async () => {
  const { runner } = runnerWith({ VPS: 'unreachable' })
  const result = await runner.runJson(VPS, ['status', '--json'])
  assert.equal(result.ok, false)
  assert.deepEqual(result.failure, { kind: 'unreachable', detail: 'Could not connect to the remote Orca runtime. (VPS)' })
})

test('install and uninstall have nothing to do in the Orca accounts mode', async () => {
  const { runner } = runnerWith({ local: { active: A.id } })
  assert.match((await runner.runLines(MAC, ['install'])).lines[0], /nothing to install/)
  assert.match((await runner.runLines(MAC, ['uninstall'])).lines[0], /nothing to install/)
})

test('the RPC runs Orca in Node mode with only the host’s own environment', async () => {
  const seen = []
  const exec = async (argv, opts) => {
    seen.push({ argv, env: opts.env })
    return { code: 0, stdout: '{"ok":true,"result":{"done":1}}\n', stderr: '' }
  }
  const s = settings()
  process.env.ORCA_ENVIRONMENT = 'leaked'
  try {
    assert.deepEqual(await orcaRpc({ settings: s, exec }, MAC, 'accounts.list', { refreshUsage: true }), { ok: true, result: { done: 1 } })
    await orcaRpc({ settings: s, exec }, VPS, 'accounts.list')
  } finally {
    delete process.env.ORCA_ENVIRONMENT
  }
  assert.equal(seen[0].argv[0], '/Applications/Orca.app/Contents/MacOS/Orca')
  assert.match(seen[0].argv[1], /lib\/orca-rpc\.cjs$/)
  assert.deepEqual(seen[0].argv.slice(3), ['accounts.list', '{"refreshUsage":true}'])
  assert.equal(seen[0].env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(seen[0].env.ORCA_ENVIRONMENT, undefined)
  assert.equal(seen[1].env.ORCA_ENVIRONMENT, 'VPS')
})

test('the hosts are this Mac and the allowed environments, read once a minute', async () => {
  let reads = 0
  let clock = NOW
  const orcaCall = async () => {
    reads += 1
    return { ok: true, result: { environments: [{ id: '1', name: 'VPS' }, { id: '2', name: 'Box' }] } }
  }
  const hostsFor = createOrcaHosts({ orcaCall, now: () => clock })
  const all = await hostsFor(settings())
  assert.deepEqual(all.map((h) => [h.name, h.orcaEnvironment, h.notifier]), [['mac', null, 'queue'], ['VPS', 'VPS', 'queue'], ['Box', 'Box', 'queue']])
  assert.deepEqual((await hostsFor(settings({ orcaAccounts: { environments: ['Box'] } }))).map((h) => h.name), ['mac', 'Box'])
  assert.equal(reads, 1)
  clock += 61000
  assert.deepEqual((await hostsFor(settings({ orcaAccounts: { environments: 'none' } }))).map((h) => h.name), ['mac'])
  await hostsFor(settings())
  assert.equal(reads, 2)
})
