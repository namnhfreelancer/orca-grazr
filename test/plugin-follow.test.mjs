import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, engine, report, settle, statusExecs, hostCalls, PANEL } from './support/plugin-harness.mjs'

// Official Orca has no commands.execute, so the worker follows the focused workspace while the drain loop runs.
const FOLLOW_MS = 3000
const DEVBOX = '00000000-0000-4000-8000-0000000000d1'
const DEVBOX_2 = '00000000-0000-4000-8000-0000000000d2'
const ENVIRONMENTS = JSON.stringify({ ok: true, result: { environments: [
  { id: DEVBOX, name: 'devbox' },
  { id: DEVBOX_2, name: 'devbox-2' },
] } })
const payload = (hostId) => `${JSON.stringify({ activeWorkspaceExecutionHostId: hostId, activeWorktreeId: 'w' })}\n`

// The focus is a variable the test moves: a workspace on this Mac ('local'), on a paired environment, or none (null).
function focusRoute(focus) {
  const answer = engine({ 'status --json': { stdout: JSON.stringify(report()) } })
  return (argv, opts) => {
    if (argv[0] === '/usr/bin/sqlite3') {
      if (focus.current === null) return { code: 1, stderr: 'database is locked' }
      return { stdout: payload(focus.current) }
    }
    if (argv[0] === '/usr/local/bin/orca') return { stdout: ENVIRONMENTS }
    return answer(argv, opts)
  }
}
const on = (environmentId) => `runtime:${environmentId}`

// Runs the follow tick the worker armed last: the fake timers never fire on their own.
async function followTick(fake) {
  const tick = fake.timers.armed.filter((t) => t.ms === FOLLOW_MS).at(-1)
  tick.fn()
  await settle()
}
const pageTarget = (fake) => fake.fs.files.get(PANEL).match(/"target":"([^"]*)"/)?.[1]

test('a change of the focused host re-renders the page with that host selected, and the target setting is not written', async () => {
  const focus = { current: 'local' }
  const fake = await start({ route: focusRoute(focus) })
  assert.equal(pageTarget(fake), 'mac')
  const writes = hostCalls(fake, 'settings.set').length
  focus.current = on(DEVBOX)
  await followTick(fake)
  assert.equal(pageTarget(fake), 'devbox')
  assert.equal(hostCalls(fake, 'settings.set').slice(writes).some((p) => p.key === 'target'), false)
  assert.equal(fake.state.settings.target, 'mac')
})

test('the page is re-rendered on a change of focus only: the same host on the next poll runs no status', async () => {
  const focus = { current: 'local' }
  const fake = await start({ route: focusRoute(focus) })
  focus.current = on(DEVBOX)
  await followTick(fake)
  const after = statusExecs(fake)
  assert.equal(after, 3)
  await followTick(fake)
  await followTick(fake)
  assert.equal(statusExecs(fake), after)
  focus.current = 'local'
  await followTick(fake)
  assert.equal(statusExecs(fake), after + 3)
  assert.equal(pageTarget(fake), 'mac')
})

test('a focus that cannot be read leaves the page as it is', async () => {
  const focus = { current: null }
  const fake = await start({ route: focusRoute(focus) })
  await followTick(fake)
  await followTick(fake)
  assert.equal(statusExecs(fake), 0)
  assert.equal(pageTarget(fake), 'mac')
})

test('the follow ends with the drain loop: after deactivate a tick reads nothing and renders nothing', async () => {
  const focus = { current: 'local' }
  const fake = await start({ route: focusRoute(focus) })
  fake.plugin.deactivate()
  focus.current = on(DEVBOX)
  const reads = fake.execs.filter((a) => a[0] === '/usr/bin/sqlite3').length
  await followTick(fake)
  assert.equal(fake.execs.filter((a) => a[0] === '/usr/bin/sqlite3').length, reads)
  assert.equal(statusExecs(fake), 0)
})

test('the followed host stays selected through the drain loop\'s own refreshes', async () => {
  const focus = { current: on(DEVBOX) }
  const fake = await start({ route: focusRoute(focus) })
  await followTick(fake)
  assert.equal(pageTarget(fake), 'devbox')
  await fake.run('drain-now')
  assert.equal(pageTarget(fake), 'devbox')
})

test('target-next hands the page back to the target setting: the followed host stops overriding it', async () => {
  const focus = { current: on(DEVBOX) }
  const fake = await start({ route: focusRoute(focus), stored: { target: 'devbox-2' } })
  await followTick(fake)
  assert.equal(pageTarget(fake), 'devbox')
  await fake.run('target-next')
  assert.equal(fake.state.settings.target, 'mac')
  assert.equal(pageTarget(fake), 'mac')
})
