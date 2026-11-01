import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, engine, label, statusExecs, report } from './support/plugin-harness.mjs'

// Calls a command the way the panel does: the params object is the handler's only argument.
const call = (fake, id, params) => fake.plugin.commands[id](params)
const ranOn = (fake, cmd, hostAlias) => fake.execs.some((a) => label(a) === cmd && a.includes(hostAlias))

test('swap with a host and an account runs swap <account> on that host and returns its message', async () => {
  const fake = await start({ route: engine({ 'swap a@b': { stdout: 'swapped\n' } }) })
  const outcome = await call(fake, 'swap', { host: 'devbox', account: 'a@b' })
  assert.ok(ranOn(fake, 'swap a@b', 'devbox'))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.message, 'devbox: swap\nswapped')
})

test('swap with no params runs a plain swap on the target, as in 0.5.x', async () => {
  const fake = await start({ route: engine({ swap: { stdout: 'swapped\n' } }) })
  await call(fake, 'swap', undefined)
  assert.ok(fake.execs.some((a) => label(a) === 'swap' && a[0] === 'python3'))
})

test('rotation-toggle with enabled false sets ENABLED 0 without reading the status first', async () => {
  const fake = await start({ route: engine({ 'set ENABLED 0': {} }) })
  const outcome = await call(fake, 'rotation-toggle', { host: 'devbox', enabled: false })
  const set = fake.execs.findIndex((a) => label(a) === 'set ENABLED 0')
  assert.ok(set >= 0)
  assert.ok(ranOn(fake, 'set ENABLED 0', 'devbox'))
  assert.ok(!fake.execs.slice(0, set).some((a) => label(a) === 'status --json'))
  assert.equal(outcome.message, 'devbox: rotation off')
})

test('refresh with a host runs on that host, not the target', async () => {
  const fake = await start({ route: engine({ refresh: { stdout: 'ok\n' } }) })
  await call(fake, 'refresh', { host: 'devbox-2' })
  assert.ok(ranOn(fake, 'refresh', 'devbox-2'))
  assert.ok(!fake.execs.some((a) => label(a) === 'refresh' && a[0] === 'python3'))
})

test('an unknown host in params runs nothing and says so: the panel is asked to refresh', async () => {
  const fake = await start({ route: engine({ refresh: { stdout: 'ok\n' } }) })
  const outcome = await call(fake, 'refresh', { host: 'nowhere' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'unknown host nowhere; refresh the panel')
  assert.equal(fake.execs.some((a) => label(a) === 'refresh'), false)
  assert.ok(fake.calls.some((c) => c.name === 'notifications.show' && c.params.title === 'unknown host nowhere; refresh the panel'))
})

test('an unknown host in enrol starts no sign-in; an empty params object still means the target', async () => {
  const fake = await start({ route: engine({}) })
  const outcome = await call(fake, 'enrol', { host: 'nowhere', account: 'a' })
  assert.equal(outcome.message, 'unknown host nowhere; refresh the panel')
  assert.equal(fake.spawns.length, 0)
})

test('panel-refresh from the panel returns its message and raises no notification; from the palette it notifies', async () => {
  const fake = await start({ route: engine({}) })
  const fromPanel = await call(fake, 'panel-refresh', {})
  assert.equal(typeof fromPanel.message, 'string')
  assert.equal(fake.calls.some((c) => c.name === 'notifications.show'), false)
  await call(fake, 'panel-refresh', undefined)
  assert.ok(fake.calls.some((c) => c.name === 'notifications.show'))
})

test('a failing engine run returns ok false with the toast text as its message', async () => {
  const fake = await start({ route: engine({ uninstall: { code: 1, stdout: 'grazr: nothing installed\n' } }) })
  const outcome = await call(fake, 'uninstall', { host: 'devbox' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'devbox: uninstall failed\nnothing installed')
})

test('the registered command passes its argument through to the handler', async () => {
  const fake = await start({ route: engine({ refresh: { stdout: 'ok\n' } }) })
  const outcome = await fake.commands.get('refresh')({ host: 'devbox' })
  assert.ok(ranOn(fake, 'refresh', 'devbox'))
  assert.equal(outcome.ok, true)
})

test('a command that throws resolves to ok false with its message and never rejects', async () => {
  const fake = await start({ route: engine({ refresh: () => { throw new Error('boom') } }) })
  const outcome = await call(fake, 'refresh', { host: 'devbox' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'grazr: boom')
})

test('status returns ok and the per-host texts it toasted', async () => {
  const fake = await start({ route: engine({ 'status --json': { stdout: JSON.stringify(report()) } }) })
  const outcome = await call(fake, 'status', undefined)
  assert.equal(outcome.ok, true)
  assert.equal(statusExecs(fake), 3)
  assert.ok(outcome.message.includes('mac: work'))
})

// The login host creates its throwaway directory here; every other call goes to the route given.
const TEMP = '/var/folders/t/tmp.1'
const withTemp = (route = engine({})) => (argv, opts) => {
  if (argv.at(-1) === 'mktemp -d') return { stdout: `${TEMP}\n` }
  // The local workspace the sign-in tab opens in: one local worktree.
  if (argv[argv.indexOf('worktree') + 1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: 'fc5::/p/orca-grazr', path: '/p/orca-grazr', repo: { displayName: 'orca-grazr' } }] } }) }
  return route(argv, opts)
}
// A sign-in reaches its login child once the ssh child is spawned; the spawn happens after the command returns.
const waitForSpawns = async (fake, n) => {
  for (let i = 0; i < 200 && fake.spawns.length < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('enrol with params starts a sign-in on that host and returns at once with its message, opening no Terminal', async () => {
  const fake = await start({ route: withTemp() })
  const outcome = await call(fake, 'enrol', { host: 'devbox', account: 'x@y' })
  assert.deepEqual(outcome, { ok: true, message: "Signing in x@y in Orca's browser — sign in, then approve Claude Code" })
  assert.equal(fake.execs.some((a) => a[0] === '/usr/bin/open'), false)
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns.length, 1)
  assert.equal(fake.spawns[0].file, '/usr/bin/ssh')
  assert.equal(fake.spawns[0].args.at(-2), 'devbox')
  assert.equal(fake.spawns[0].args.at(-1), `CLAUDE_CONFIG_DIR=${TEMP} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login --email x@y'`)
})

test('enrol on the Mac with no account says it will sign in to a new account, on the first remote host with an environment', async () => {
  const fake = await start({ route: withTemp() })
  const outcome = await call(fake, 'enrol', { host: 'mac' })
  assert.equal(outcome.message, "Signing in a new account in Orca's browser — sign in, then approve Claude Code")
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns[0].args.at(-2), 'devbox')
  assert.equal(fake.spawns[0].args.at(-1), `CLAUDE_CONFIG_DIR=${TEMP} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login'`)
})

test('a second enrol for the same host cancels the running sign-in and starts the new one once the first has released its login', async () => {
  const fake = await start({ route: withTemp() })
  await call(fake, 'enrol', { host: 'devbox' })
  await waitForSpawns(fake, 1)
  const again = await call(fake, 'enrol', { host: 'devbox' })
  assert.deepEqual(again, { ok: true, message: "Signing in a new account in Orca's browser — sign in, then approve Claude Code" })
  assert.deepEqual(fake.spawns[0].child.killed, ['SIGTERM'])
  fake.spawns[0].child.emit('close', null, 'SIGTERM')
  await waitForSpawns(fake, 2)
  assert.equal(fake.spawns.length, 2)
  assert.ok(fake.execs.some((a) => label(a) === `login-discard --from ${TEMP}`))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fake.calls.some((c) => c.name === 'notifications.show' && c.params.title === 'devbox: sign-in cancelled'))
})

test('enrol with an empty params object is a panel call: it starts a sign-in on the target host', async () => {
  const fake = await start({ route: withTemp() })
  const outcome = await call(fake, 'enrol', {})
  assert.equal(outcome.ok, true)
  await waitForSpawns(fake, 1)
  assert.equal(fake.spawns.length, 1)
  assert.equal(fake.spawns[0].args.at(-2), 'devbox')
})

test('enrol with no params (the palette) types into the newest terminal and opens no window', async () => {
  const context = { terminals: [{ id: 't1' }] }
  const fake = await start({ context, route: engine({}) })
  await call(fake, 'enrol', undefined)
  assert.equal(fake.execs.some((a) => a[0] === '/usr/bin/open'), false)
  assert.ok(fake.calls.some((c) => c.name === 'terminal.sendText' && c.params.terminalId === 't1'))
})

test('swap with an empty account string runs a plain swap', async () => {
  const fake = await start({ route: engine({ swap: { stdout: 'swapped\n' } }) })
  await call(fake, 'swap', { host: 'mac', account: '' })
  assert.ok(fake.execs.some((a) => label(a) === 'swap' && a[0] === 'python3'))
})
