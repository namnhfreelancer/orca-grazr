import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { isSignInUrl, LOGIN_TIMEOUT_MS, REMOTE_KILL_AFTER_S, REMOTE_LOGIN_TIMEOUT_S } from '../lib/signin.mjs'
import { DEV, MAC, SETTINGS, SSH, D1, LABEL, URL, VISIT, argAfter, callsWith, closesOf, deletesOf, harness, json, singleLine, openRemoteTab, until } from './support/signin-harness.mjs'

test('Orca pretty-printed JSON replies parse, and a single-line reply still parses', async () => {
  const pretty = harness()
  const a = await openRemoteTab(pretty, null)
  assert.equal(callsWith(pretty, 'tab profile list').length >= 1, true)
  assert.equal(argAfter(callsWith(pretty, 'tab create')[0], '--profile'), 'p1')
  a.exit(null, '', 'SIGTERM')
  await until(() => pretty.refreshes === 1)

  const oneLine = harness({ overrides: { 'tab profile list': () => ({ stdout: singleLine({ ok: true, result: { profiles: oneLine.profiles } }) }) } })
  const b = await openRemoteTab(oneLine, null)
  assert.equal(argAfter(callsWith(oneLine, 'tab create')[0], '--profile'), 'p1')
  b.exit(null, '', 'SIGTERM')
  await until(() => oneLine.refreshes === 1)
})

test('the remote login runs over plain ssh (no pty), in its own process group, under timeout(1) that kills claude after TERM', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { file, args } = h.spawns[0]
  assert.equal(file, SSH)
  assert.deepEqual(args.slice(0, -2), SETTINGS.sshOptions, 'no -t: a pty made claude print nothing')
  assert.equal(args.at(-2), 'devbox')
  assert.equal(args.at(-1), `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k ${REMOTE_KILL_AFTER_S} ${REMOTE_LOGIN_TIMEOUT_S} ~/.local/bin/claude auth login'`)
  assert.equal(REMOTE_LOGIN_TIMEOUT_S, 1830)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
})

test('a CRLF pty line carries the address; a bare address is taken after 500 ms of quiet; the end of output takes it too', async () => {
  const crlf = harness()
  const a = await openRemoteTab(crlf, null)
  assert.equal(callsWith(crlf, 'tab create')[0].args.includes(URL), true)
  a.exit(null, '', 'SIGTERM')
  await until(() => crlf.refreshes === 1)

  const bare = harness()
  bare.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => bare.spawns.length === 1)
  bare.spawns[0].child.emitUrlBare('stdout')
  assert.equal(callsWith(bare, 'tab create').length, 0, 'not taken before the quiet period')
  bare.clock.fire(500)
  await until(() => callsWith(bare, 'tab create').length === 1)
  bare.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => bare.refreshes === 1)

  const ended = harness()
  ended.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => ended.spawns.length === 1)
  ended.spawns[0].child.emitUrlBare('stdout')
  ended.spawns[0].child.stdout.emit('end')
  await until(() => callsWith(ended, 'tab create').length === 1)
  ended.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => ended.refreshes === 1)
})

test('the address may come on stderr', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.spawns[0].child.stderr.emit('data', Buffer.from(VISIT))
  await until(() => callsWith(h, 'tab create').length === 1)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
})

test('an address on a site that is not Claude is not opened: the login is stopped and the card says so', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  child.stdout.emit('data', Buffer.from('visit: https://evil.example.com/login\n'))
  await until(() => child.signals.length === 1)
  child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.match(h.published[0].body, /not on claude\.ai, claude\.com or anthropic\.com, so nothing was opened/)
  assert.equal(callsWith(h, 'tab create').length, 0)
  assert.equal(callsWith(h, 'tab profile').length, 0)
})

test('only https addresses on Claude sites or their subdomains are accepted', () => {
  assert.equal(isSignInUrl('https://claude.ai/oauth/authorize?x=1'), true)
  assert.equal(isSignInUrl('https://claude.com/cai/oauth'), true)
  assert.equal(isSignInUrl('https://console.anthropic.com/login'), true)
  assert.equal(isSignInUrl('http://claude.ai/login'), false)
  assert.equal(isSignInUrl('https://evilclaude.ai/login'), false)
  assert.equal(isSignInUrl('https://claude.ai.evil.example/login'), false)
  assert.equal(isSignInUrl('not a url'), false)
})

test('a tab that fails to open: tabs on the same address are closed, and the login is stopped and discarded', async () => {
  const h = harness({
    overrides: {
      'tab create': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'timed out' } }) }),
      'tab list': () => ({ stdout: json({ ok: true, result: { tabs: [{ url: URL, browserPageId: 'stale-9' }, { url: 'https://claude.ai/other', browserPageId: 'keep' }] } }) }),
    },
  })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  child.emitUrl()
  await until(() => child.signals.length === 1)
  child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(closesOf(h, 'stale-9').length, 1)
  assert.equal(closesOf(h, 'keep').length, 0)
  assert.equal(callsWith(h, 'login-discard').length, 1)
  assert.match(h.published[0].body, /could not open the sign-in: timed out/)
})

test('a fresh profile is recorded as soon as Orca makes it: cancelling during the create still deletes it', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const h = harness({
    overrides: {
      'tab profile create': async (c) => {
        await gate
        h.profiles.push({ id: 'p1', label: argAfter(c, '--label') })
        return { stdout: json({ ok: true, result: {} }) }
      },
    },
  })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.spawns[0].child.emitUrl()
  await until(() => callsWith(h, 'tab profile create').length === 1)
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.deepEqual(h.spawns[0].child.signals, ['SIGTERM'])
  open()
  await until(() => h.spawns[0].child.signals.length === 1)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
  assert.equal(argAfter(deletesOf(h)[0], '--profile'), 'p1', 'the cancelled sign-in deleted its profile')
  assert.equal(h.published[0].title, 'devbox: sign-in cancelled')
})

test('when the list after the create fails, the fresh profile is found again by its label and deleted', async () => {
  let lists = 0
  const h = harness({
    overrides: {
      'tab profile list': () => {
        lists++
        if (lists === 2) return { code: 1, stdout: json({ ok: false, error: { message: 'busy' } }) }
        return { stdout: json({ ok: true, result: { profiles: h.profiles } }) }
      },
    },
  })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.spawns[0].child.emitUrl()
  await until(() => h.refreshes === 0 && callsWith(h, 'tab profile create').length === 1)
  h.spawns[0].child.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(argAfter(deletesOf(h)[0], '--profile'), 'p1')
  assert.equal(h.published[0].body, 'Orca\'s browser in the orca-grazr workspace could not open the sign-in: busy\nNothing was enrolled.')
  assert.deepEqual(h.profiles, [])
})

test('two concurrent add-account sign-ins get distinct fresh profiles, and each tab uses its own', async () => {
  const h = harness({ suffix: () => randomBytes(2).toString('hex') })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  h.jobs.start({ host: MAC, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 2)
  h.spawns[0].child.emitUrl()
  h.spawns[1].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 2)
  const labels = callsWith(h, 'tab profile create').map((c) => argAfter(c, '--label'))
  assert.equal(new Set(labels).size, 2, 'labels differ')
  const used = callsWith(h, 'tab create').map((c) => argAfter(c, '--profile'))
  assert.equal(new Set(used).size, 2, 'each sign-in has its own profile')
  h.spawns[0].child.exit(0)
  h.spawns[1].child.exit(0)
  await until(() => h.refreshes === 2)
  assert.deepEqual(h.profiles, [])
  assert.equal(deletesOf(h).length, 2)
})

test('the limit firing before the address appears reports a timed-out sign-in', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.clock.fire(LOGIN_TIMEOUT_MS)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
  assert.equal(h.published[0].body, 'Nothing was enrolled.')
  assert.equal(callsWith(h, 'tab create').length, 0)
})
