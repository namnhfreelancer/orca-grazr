import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFocus, ENVIRONMENT_CACHE_MS } from '../lib/focus.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'
import { start, toasts } from './support/plugin-harness.mjs'

const DEVBOX = '00000000-0000-4000-8000-0000000000d1'
const DEVBOX_2 = '00000000-0000-4000-8000-0000000000d2'
const SETTINGS = fixtureSettings({ hosts: [
  { name: 'mac', ssh: null },
  { name: 'devbox', ssh: 'devbox' },
  { name: 'devbox-2', ssh: 'devbox-2' },
] })
const DB = '/home/t/Library/Application Support/orca/profiles/local-default/profile-state.db'
const ENVIRONMENTS = JSON.stringify({ ok: true, result: { environments: [
  { id: DEVBOX, name: 'devbox' },
  { id: DEVBOX_2, name: 'devbox-2' },
] } }, null, 2)

// The session row's payload for a given execution host id, as sqlite3 prints it.
const payload = (hostId) => `${JSON.stringify({ activeWorkspaceExecutionHostId: hostId, activeWorktreeId: 'w' })}\n`

// A fake exec: sqlite3 answers with the payload from the script, orca environment list with the list. Every argv is recorded.
function fakeExec({ sqlite = () => ({ stdout: payload('local') }), environments = () => ({ stdout: ENVIRONMENTS }) } = {}) {
  const argvs = []
  const exec = async (argv, opts = {}) => {
    argvs.push(argv)
    const base = { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs }
    if (argv[0] === SETTINGS.sqliteBin) return { ...base, ...sqlite() }
    if (argv[0] === SETTINGS.orcaBin) return { ...base, ...environments() }
    throw new Error(`unexpected argv ${argv.join(' ')}`)
  }
  return { exec, argvs, sqliteCalls: () => argvs.filter((a) => a[0] === SETTINGS.sqliteBin), envCalls: () => argvs.filter((a) => a[0] === SETTINGS.orcaBin) }
}

function focusWith(exec, { now = () => 1000, settings = SETTINGS } = {}) {
  const logs = []
  const focus = createFocus({ exec, homedir: () => '/home/t', now, log: (m) => logs.push(m) })
  return { current: () => focus.current(settings), logs }
}

test('a workspace on a paired environment maps to the plugin host of that environment', async () => {
  const fake = fakeExec({ sqlite: () => ({ stdout: payload(`runtime:${DEVBOX}`) }) })
  assert.deepEqual(await focusWith(fake.exec).current(), { ok: true, host: 'devbox' })
  const second = fakeExec({ sqlite: () => ({ stdout: payload(`runtime:${DEVBOX_2}`) }) })
  assert.deepEqual(await focusWith(second.exec).current(), { ok: true, host: 'devbox-2' })
})

test('any host id that is not a runtime is this Mac, the host with no ssh alias', async () => {
  const fake = fakeExec({ sqlite: () => ({ stdout: payload('local') }) })
  assert.deepEqual(await focusWith(fake.exec).current(), { ok: true, host: 'mac' })
  const none = fakeExec({ sqlite: () => ({ stdout: payload(null) }) })
  assert.deepEqual(await focusWith(none.exec).current(), { ok: true, host: 'mac' })
  assert.equal(none.envCalls().length, 0, 'a local workspace never asks for the environment list')
})

test('a runtime id that no environment has maps to no host', async () => {
  const fake = fakeExec({ sqlite: () => ({ stdout: payload('runtime:00000000-0000-0000-0000-000000000000') }) })
  assert.deepEqual(await focusWith(fake.exec).current(), { ok: true, host: null })
})

test('an environment with no configured host maps to no host', async () => {
  const other = '9c1d2e3f-0000-4000-8000-000000000001'
  const fake = fakeExec({
    sqlite: () => ({ stdout: payload(`runtime:${other}`) }),
    environments: () => ({ stdout: JSON.stringify({ ok: true, result: { environments: [{ id: other, name: 'lab' }] } }) }),
  })
  assert.deepEqual(await focusWith(fake.exec).current(), { ok: true, host: null })
})

test('a host that names its environment matches by orcaEnvironment', async () => {
  const settings = fixtureSettings({ hosts: [{ name: 'mac', ssh: null }, { name: 'lab', ssh: 'lab-box', orcaEnvironment: 'devbox-2' }] })
  const fake = fakeExec({ sqlite: () => ({ stdout: payload(`runtime:${DEVBOX_2}`) }) })
  assert.deepEqual(await focusWith(fake.exec, { settings }).current(), { ok: true, host: 'lab' })
})

test('the sqlite read is read-only, on the expanded profile database, and runs the query', async () => {
  const fake = fakeExec()
  await focusWith(fake.exec).current()
  assert.deepEqual(fake.sqliteCalls()[0].slice(0, 3), ['/usr/bin/sqlite3', '-readonly', DB])
  assert.match(fake.sqliteCalls()[0][3], /from profile_state_documents where domain='workspaceSession'/)
})

test('the environment list is read with the orca CLI and cached for 60 seconds', async () => {
  const fake = fakeExec({ sqlite: () => ({ stdout: payload(`runtime:${DEVBOX}`) }) })
  let clock = 1000
  const focus = focusWith(fake.exec, { now: () => clock })
  assert.deepEqual(await focus.current(), { ok: true, host: 'devbox' })
  assert.deepEqual(await focus.current(), { ok: true, host: 'devbox' })
  assert.equal(fake.envCalls().length, 1)
  assert.deepEqual(fake.envCalls()[0].slice(0, 3), [SETTINGS.orcaBin, 'environment', 'list'])
  clock += ENVIRONMENT_CACHE_MS
  await focus.current()
  assert.equal(fake.envCalls().length, 2)
})

test('a failed sqlite read is quiet: ok false, no host, logged once for the whole streak', async () => {
  const fake = fakeExec({ sqlite: () => ({ code: 1, stderr: 'database is locked' }) })
  const focus = focusWith(fake.exec)
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await focus.current(), { ok: false, host: null })
  assert.equal(focus.logs.length, 1)
  assert.match(focus.logs[0], /database is locked/)
})

test('a sqlite binary that cannot run and a payload that is not JSON both fail quietly', async () => {
  const missing = fakeExec({ sqlite: () => ({ code: null, spawnError: new Error('ENOENT') }) })
  assert.deepEqual(await focusWith(missing.exec).current(), { ok: false, host: null })
  const garbage = fakeExec({ sqlite: () => ({ stdout: 'not json\n' }) })
  assert.deepEqual(await focusWith(garbage.exec).current(), { ok: false, host: null })
})

test('a failed environment list gives no host and is not cached, so the next read asks again', async () => {
  let fail = true
  const fake = fakeExec({
    sqlite: () => ({ stdout: payload(`runtime:${DEVBOX}`) }),
    environments: () => (fail ? { code: 2, stderr: 'orca not running' } : { stdout: ENVIRONMENTS }),
  })
  const focus = focusWith(fake.exec)
  assert.deepEqual(await focus.current(), { ok: false, host: null })
  fail = false
  assert.deepEqual(await focus.current(), { ok: true, host: 'devbox' })
  assert.equal(fake.envCalls().length, 2)
})

test('the palette command toasts the focused host; the panel call gets the host quietly', async () => {
  const fake = await start({ route: (argv) => (argv[0] === '/usr/bin/sqlite3' ? { stdout: payload(`runtime:${DEVBOX}`) } : argv[0] === '/usr/local/bin/orca' ? { stdout: ENVIRONMENTS } : {}) })
  fake.calls.length = 0
  fake.execs.length = 0
  const quiet = await fake.plugin.commands['active-host']({})
  assert.deepEqual(quiet, { ok: true, message: '', host: 'devbox' })
  assert.deepEqual(toasts(fake), [])
  const palette = await fake.plugin.commands['active-host']()
  assert.equal(palette.host, 'devbox')
  assert.equal(toasts(fake).at(-1).title, 'grazr: Focused workspace: devbox')
})

test('the palette command says so when the session cannot be read', async () => {
  const fake = await start({ route: (argv) => (argv[0] === '/usr/bin/sqlite3' ? { code: 1, stderr: 'no such table' } : {}) })
  fake.calls.length = 0
  const outcome = await fake.plugin.commands['active-host']()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.host, null)
  assert.equal(toasts(fake).at(-1).title, 'grazr: Focused workspace: unknown')
})
