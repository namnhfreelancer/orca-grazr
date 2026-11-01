import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, engine, label, report } from './support/plugin-harness.mjs'

// Official Orca: a palette command (no params) acts on the server of the focused workspace; a panel call keeps its host.
const DEVBOX = '00000000-0000-4000-8000-0000000000d1'
// A workspace on a paired environment names it as runtime:<environment id>.
const ON_DEVBOX = `runtime:${DEVBOX}`
const ENVIRONMENTS = JSON.stringify({ ok: true, result: { environments: [{ id: DEVBOX, name: 'devbox' }] } })
const payload = (hostId) => `${JSON.stringify({ activeWorkspaceExecutionHostId: hostId, activeWorktreeId: 'w' })}\n`
const call = (fake, id, params) => fake.plugin.commands[id](params)
const sqliteReads = (fake) => fake.execs.filter((a) => a[0] === '/usr/bin/sqlite3').length

// The focus: the session row names the host id given (or the read fails when focus is null); the environment list names devbox.
const withFocus = (focus, table = {}) => {
  const answer = engine({ 'status --json': { stdout: JSON.stringify(report()) }, ...table })
  return (argv, opts) => {
    if (argv[0] === '/usr/bin/sqlite3') return focus === null ? { code: 1, stderr: 'database is locked' } : { stdout: payload(focus) }
    if (argv[0] === '/usr/local/bin/orca') return { stdout: ENVIRONMENTS }
    return answer(argv, opts)
  }
}

// The login child is spawned after the command returns; a test waits for it here.
const waitForSpawns = async (fake, n) => {
  for (let i = 0; i < 200 && fake.spawns.length < n; i++) await new Promise((resolve) => setImmediate(resolve))
}
const TEMP = '/var/folders/t/tmp.1'
const withTemp = (route) => (argv, opts) => {
  if (argv.at(-1) === 'mktemp -d') return { stdout: `${TEMP}\n` }
  if (argv[argv.indexOf('worktree') + 1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: 'fc5::/p/orca-grazr', path: '/p/orca-grazr', repo: { displayName: 'orca-grazr' } }] } }) }
  return route(argv, opts)
}

test('a palette swap acts on the focused workspace\'s server, not the target', async () => {
  const fake = await start({ route: withFocus(ON_DEVBOX, { swap: { stdout: 'swapped\n' } }) })
  await call(fake, 'swap', undefined)
  assert.ok(fake.execs.some((a) => label(a) === 'swap' && a.includes('devbox')))
  assert.equal(fake.execs.some((a) => label(a) === 'swap' && a[0] === 'python3'), false)
})

test('with the focus unknown, a palette command falls back to the target', async () => {
  const fake = await start({ route: withFocus(null, { swap: { stdout: 'swapped\n' } }) })
  await call(fake, 'swap', undefined)
  assert.ok(fake.execs.some((a) => label(a) === 'swap' && a[0] === 'python3'))
})

test('a panel call names its host and never reads the focus', async () => {
  const fake = await start({ route: withFocus(ON_DEVBOX, { swap: { stdout: 'swapped\n' } }) })
  await call(fake, 'swap', { host: 'mac' })
  assert.equal(sqliteReads(fake), 0)
  assert.ok(fake.execs.some((a) => label(a) === 'swap' && a[0] === 'python3'))
})

test('the focus is read at most once per 3 seconds for palette commands', async () => {
  let clock = 1000
  const fake = await start({ route: withFocus(ON_DEVBOX, { swap: { stdout: 'ok\n' } }), now: () => clock })
  await call(fake, 'swap', undefined)
  assert.equal(sqliteReads(fake), 1)
  clock = 3500
  await call(fake, 'swap', undefined)
  assert.equal(sqliteReads(fake), 1)
  clock = 4500
  await call(fake, 'swap', undefined)
  assert.equal(sqliteReads(fake), 2)
})

test('reauth signs in the first blocked account in rotation order, on the focused server', async () => {
  const accounts = [
    { name: 'a', id: 'a1', snapshot: [] },
    { name: 'b', id: 'b1', blocked: 'weekly limit', snapshot: [] },
    { name: 'c', id: 'c1', blocked: 'session limit', snapshot: [] },
  ]
  const fake = await start({ route: withTemp(withFocus(ON_DEVBOX, { 'status --json': { stdout: JSON.stringify(report({ accounts, order: ['c', 'b', 'a'] })) } })) })
  const outcome = await call(fake, 'reauth', undefined)
  assert.ok(outcome.message.includes("Signing in c in Orca's browser"))
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns[0].file, '/usr/bin/ssh')
  assert.equal(fake.spawns[0].args.at(-2), 'devbox')
  assert.ok(fake.spawns[0].args.at(-1).includes('--email c'))
  assert.ok(fake.execs.some((a) => label(a) === 'status --json' && a.includes('devbox')))
})

test('reauth with no blocked account says so and starts no sign-in', async () => {
  const fake = await start({ route: withTemp(withFocus(ON_DEVBOX)) })
  const outcome = await call(fake, 'reauth', undefined)
  assert.deepEqual(outcome, { ok: true, message: 'devbox: no blocked account' })
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns.length, 0)
})

test('add-account starts a new-account sign-in on the focused server', async () => {
  const fake = await start({ route: withTemp(withFocus(ON_DEVBOX)) })
  const outcome = await call(fake, 'add-account', undefined)
  assert.ok(outcome.message.includes('Signing in a new account in Orca\'s browser'))
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns[0].args.at(-2), 'devbox')
})

test('a palette uninstall keeps the target, whatever the focus: its title names the target', async () => {
  const fake = await start({ route: withFocus(ON_DEVBOX, { uninstall: { stdout: 'removed\n' } }) })
  await call(fake, 'uninstall', undefined)
  assert.ok(fake.execs.some((a) => label(a) === 'uninstall' && a[0] === 'python3'))
  assert.equal(fake.execs.some((a) => label(a) === 'uninstall' && a.includes('devbox')), false)
})
