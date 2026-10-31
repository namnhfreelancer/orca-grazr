import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureSettings } from './support/fixture-hosts.mjs'
import { D1, DEV, EXPORT_LINE, LOCAL_WORKTREE, MAC, NO_WORKSPACE, SETTINGS, WORKSPACE, argAfter, assertCleaned, callsWith, discardsOf, harness, json, tabCallsOf, until } from './support/signin-harness.mjs'

// Three ssh hosts, the Mac among them. The sign-in tab goes to the local workspace, whatever host logs in.
const THREE = [{ name: 'mac' }, { name: 'devbox', ssh: 'devbox' }, { name: 'devbox-2', ssh: 'devbox-2' }, { name: 'devbox3', ssh: 'devbox3' }]
const OTHER = { id: 'aa11::/home/t/src/other', path: '/home/t/src/other', displayName: 'main', repo: { displayName: 'other' } }
const listing = (...worktrees) => ({ 'worktree list': () => ({ stdout: json({ ok: true, result: { worktrees } }) }) })

// Ends a started sign-in through its login and waits for the card to be told.
async function finish(h, login, exit = 0) {
  const next = h.refreshes + 1
  login.exit(exit)
  await until(() => h.refreshes === next)
}

test('a remote card logs in on its own host and opens the tab in the local workspace, named by its repo', async () => {
  const h = harness()
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, account: null }), { ok: true, message: "Signing in a new account in Orca's browser — sign in, then approve Claude Code" })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-2), 'devbox', 'the login runs on the card\'s own host')
  const login = h.spawns[0].child
  login.emitPid()
  login.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  const create = callsWith(h, 'tab create')[0]
  assert.equal(argAfter(create, '--worktree'), WORKSPACE)
  assert.equal(create.args.includes('--environment'), false)
  await finish(h, login)
  assert.equal(callsWith(h, 'enrol --from')[0].where, 'devbox', 'the login host enrols its own login')
  assert.equal(h.published[0].title, 'devbox: signed in')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('the default workspace is the first local worktree, unless the plugin folder is one: then that one', async () => {
  const first = harness({ overrides: listing(OTHER, LOCAL_WORKTREE) })
  assert.equal((await first.jobs.start({ host: DEV, settings: SETTINGS, account: null })).ok, true)
  await until(() => first.spawns.length === 1)
  first.spawns[0].child.emitUrl()
  await until(() => callsWith(first, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(first, 'tab create')[0], '--worktree'), 'id:aa11::/home/t/src/other', 'no plugin folder listed: the first one')
  first.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => first.refreshes === 1)

  const plugin = harness({ overrides: listing(OTHER, LOCAL_WORKTREE), pluginRoot: LOCAL_WORKTREE.path })
  const outcome = await plugin.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.equal(outcome.message, "Signing in a new account in Orca's browser — sign in, then approve Claude Code")
  await until(() => plugin.spawns.length === 1)
  plugin.spawns[0].child.emitUrl()
  await until(() => callsWith(plugin, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(plugin, 'tab create')[0], '--worktree'), WORKSPACE, 'the plugin folder wins')
  plugin.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => plugin.refreshes === 1)
})

test('signinWorkspace names the workspace the tab opens in, by id: or path:, and is labelled from the list when it is there', async () => {
  const byId = fixtureSettings({ signinWorkspace: `id:${OTHER.id}` })
  const a = harness({ settings: byId, overrides: listing(LOCAL_WORKTREE, OTHER) })
  assert.equal((await a.jobs.start({ host: DEV, settings: byId, account: null })).message, "Signing in a new account in Orca's browser — sign in, then approve Claude Code")
  await until(() => a.spawns.length === 1)
  a.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => a.refreshes === 1)

  const byPath = fixtureSettings({ signinWorkspace: 'path:/home/t/elsewhere' })
  const b = harness({ settings: byPath, overrides: listing(LOCAL_WORKTREE) })
  assert.equal((await b.jobs.start({ host: DEV, settings: byPath, account: null })).message, "Signing in a new account in Orca's browser — sign in, then approve Claude Code")
  await until(() => b.spawns.length === 1)
  b.spawns[0].child.emitUrl()
  await until(() => callsWith(b, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(b, 'tab create')[0], '--worktree'), 'path:/home/t/elsewhere')
  b.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => b.refreshes === 1)
})

test('no local worktree: the sign-in is refused with the message, and nothing runs', async () => {
  const h = harness({ overrides: listing() })
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, account: null }), { ok: false, message: NO_WORKSPACE })
  assert.equal(NO_WORKSPACE, 'Sign-in needs a local project in Orca: add any folder on this Mac as a project (Orca › Add project), then click again')
  assert.equal(h.spawns.length, 0)
  assert.equal(callsWith(h, 'mktemp').length, 0)
  assert.equal(callsWith(h, 'tab create').length, 0)
  assert.equal(h.jobs.running.size, 0)
})

test('a worktree list that cannot be read refuses the sign-in with Orca\'s message, and nothing runs', async () => {
  const h = harness({ overrides: { 'worktree list': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'Orca is not running' } }) }) } })
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, account: null }), { ok: false, message: 'Orca is not running' })
  assert.equal(h.spawns.length, 0)
})

test('no tab or profile call on this Mac carries --environment, for a remote card or a Mac card', async () => {
  for (const host of [DEV, MAC]) {
    const h = harness()
    const login = await startAndTab(h, host)
    await finish(h, login)
    const calls = tabCallsOf(h)
    assert.ok(calls.some((c) => c.args[0] === 'tab' && c.args[1] === 'create'), 'the tab is created')
    assert.ok(calls.length >= 3)
    for (const c of calls) assert.equal(c.args.includes('--environment'), false, c.line)
    assertCleaned(h, { dir: D1, page: 'page-1' })
  }
})

test('a Mac card logs in on signinHost, opens the tab in the local workspace, and enrols on the Mac from stdin with the export read on the login host', async () => {
  const settings = fixtureSettings({ signinHost: 'devbox-2' })
  const h = harness({ settings })
  await h.jobs.start({ host: MAC, settings, account: 'a@example.com' })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-2), 'devbox-2', 'the login runs on signinHost')
  const login = h.spawns[0].child
  login.emitPid()
  login.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--worktree'), WORKSPACE)
  await finish(h, login)

  const exported = callsWith(h, 'login-export')
  assert.equal(exported.length, 1)
  assert.equal(exported[0].where, 'devbox-2', 'the export is read where the login ran')
  const stdin = callsWith(h, 'enrol --stdin')
  assert.equal(stdin.length, 1)
  assert.equal(stdin[0].where, 'local', 'the Mac enrols')
  assert.equal(stdin[0].input, EXPORT_LINE, 'the export arrives on stdin')
  assert.match(stdin[0].line, /enrol --stdin --name a@example\.com --expect-email a@example\.com --json$/)
  assert.equal(callsWith(h, 'enrol --from').length, 0, 'no login directory is read on another host')
  assert.equal(h.published[0].title, 'mac: signed in')
  assert.equal(h.published[0].body, 'Enrolled a@example.com on mac')
  const outside = JSON.stringify([h.calls.map((c) => [c.bin, c.where, c.line, c.args]), h.spawns.map((s) => s.args), h.published, h.logs])
  assert.equal(outside.includes('sk-secret'), false, 'the credential is in no argument, log or toast')
  assert.equal(discardsOf(h, D1)[0].where, 'devbox-2', 'the login is discarded where it ran')
})

test('a Mac card with no signinHost logs in on the first remote host; the start message names the account', async () => {
  const h = harness()
  assert.deepEqual(await h.jobs.start({ host: MAC, settings: SETTINGS, account: 'x@example.com' }), { ok: true, message: "Signing in x@example.com in Orca's browser — sign in, then approve Claude Code" })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-2), 'devbox')
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
})

// Starts a sign-in and waits until its tab is open; returns the login.
async function startAndTab(h, host) {
  await h.jobs.start({ host, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const login = h.spawns[0].child
  login.emitPid()
  login.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  return login
}
