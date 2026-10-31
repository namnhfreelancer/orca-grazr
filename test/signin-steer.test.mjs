import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOGIN_TIMEOUT_MS, offTheFlow, REMOTE_LOGIN_TIMEOUT_S, RELAY_POLL_MS, STEER_GAP_MS, STEER_MAX } from '../lib/signin.mjs'
import { D1, DEV, NOW, SETTINGS, URL, WORKSPACE, argAfter, assertCleaned, callsWith, harness, json, openRemoteTab, until } from './support/signin-harness.mjs'

// One poll of the tab's address: waits for the poll to be armed, fires it, and lets its answer (and any steer) land.
async function tick(h) {
  await until(() => h.clock.hasTimer(RELAY_POLL_MS))
  const before = callsWith(h, 'tab show').length
  h.clock.fire(RELAY_POLL_MS)
  await until(() => callsWith(h, 'tab show').length === before + 1)
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

// A harness whose tab shows page.url, with a clock the test moves. closeTab() makes the tab gone.
function tabAt(extra = {}) {
  const page = { url: URL, gone: false }
  const h = harness({
    nowMs: NOW.getTime(),
    ...extra,
    overrides: {
      'tab show': () => (page.gone
        ? { code: 1, stdout: json({ ok: false, error: { message: 'no such tab' } }) }
        : { stdout: json({ ok: true, result: { tab: { url: page.url } } }) }),
      ...(extra.overrides ?? {}),
    },
  })
  h.closeTab = () => { page.gone = true }
  return { h, page }
}

const steered = (h) => callsWith(h, 'goto')

test('the new tab is brought to the front in its workspace; a failure is logged and the sign-in goes on', async () => {
  const { h } = tabAt()
  const login = await openRemoteTab(h, null)
  const focus = callsWith(h, 'tab switch')
  assert.equal(focus.length, 1)
  assert.equal(argAfter(focus[0], '--page'), 'page-1')
  assert.equal(argAfter(focus[0], '--worktree'), WORKSPACE)
  assert.ok(focus[0].args.includes('--focus'))

  const failing = harness({ overrides: { 'tab switch': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'window busy' } }) }) } })
  const other = await openRemoteTab(failing, null)
  assert.ok(failing.logs.some((m) => m.includes('could not be brought to the front: window busy')), failing.logs.join(' | '))
  other.exit(0)
  await until(() => failing.refreshes === 1)
  assert.equal(failing.published[0].title, 'devbox: signed in')

  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('a tab that lands on claude.ai/new is returned to the authorize page with one goto: the page, the workspace and the authorize address', async () => {
  const { h, page } = tabAt()
  const login = await openRemoteTab(h, null)
  page.url = 'https://claude.ai/new'
  await tick(h)
  await until(() => steered(h).length === 1)
  const [goto] = steered(h)
  assert.equal(argAfter(goto, '--page'), 'page-1')
  assert.equal(argAfter(goto, '--worktree'), WORKSPACE)
  assert.equal(argAfter(goto, '--url'), URL)
  assert.equal(goto.args.includes('--environment'), false)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: signed in')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a tab on the sign-in flow is never steered: the login page, its sub-pages, the OAuth pages, the API, verify, sso and auth', async () => {
  const { h, page } = tabAt()
  const login = await openRemoteTab(h, null)
  for (const url of [
    'https://claude.ai/login',
    'https://claude.ai/login?next=%2Fnew',
    'https://claude.ai/login/sso',
    'https://claude.com/cai/oauth/authorize?code=1&state=s',
    'https://claude.ai/oauth/consent',
    'https://claude.ai/api/auth/callback',
    'https://claude.ai/verify?t=1',
    'https://claude.ai/sso/acme',
    'https://claude.ai/auth',
  ]) {
    page.url = url
    await tick(h)
    assert.equal(steered(h).length, 0, url)
  }
  login.exit(0)
  await until(() => h.refreshes === 1)
})

test('a page off claude.ai and claude.com is not steered', async () => {
  const { h, page } = tabAt()
  const login = await openRemoteTab(h, null)
  page.url = 'https://example.com/welcome'
  await tick(h)
  page.url = 'http://claude.ai/new'
  await tick(h)
  assert.equal(steered(h).length, 0)
  login.exit(0)
  await until(() => h.refreshes === 1)
})

test('a steer waits STEER_GAP_MS after the last one: an answer one millisecond early is not steered, the next one is', async () => {
  const { h, page } = tabAt()
  const login = await openRemoteTab(h, null)
  page.url = 'https://claude.ai/new'
  await tick(h)
  await until(() => steered(h).length === 1)
  h.clockNow.ms += STEER_GAP_MS - 1
  await tick(h)
  assert.equal(steered(h).length, 1, 'too soon')
  h.clockNow.ms += 1
  await tick(h)
  await until(() => steered(h).length === 2)
  login.exit(0)
  await until(() => h.refreshes === 1)
})

test('a sign-in steers a tab at most STEER_MAX times, each logged with its count, and then leaves it alone', async () => {
  const { h, page } = tabAt()
  page.url = 'https://claude.ai/new'
  const login = await openRemoteTab(h, null)
  await until(() => steered(h).length === 1)
  for (let i = 0; i < 8; i++) {
    h.clockNow.ms += STEER_GAP_MS
    await tick(h)
  }
  assert.equal(steered(h).length, STEER_MAX)
  const lines = h.logs.filter((m) => m.includes('returned it to the authorize page'))
  assert.equal(lines.length, STEER_MAX)
  assert.match(lines.at(-1), new RegExp(`\\(${STEER_MAX} of ${STEER_MAX}\\)$`))
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'polling goes on after the cap')
  login.exit(0)
  await until(() => h.refreshes === 1)
})

test('a goto that fails is logged, and polling goes on', async () => {
  const { h, page } = tabAt({ overrides: { goto: () => ({ code: 1, stdout: json({ ok: false, error: { message: 'tab busy' } }) }) } })
  const login = await openRemoteTab(h, null)
  page.url = 'https://claude.ai/new'
  await tick(h)
  await until(() => steered(h).length === 1)
  assert.ok(h.logs.some((m) => m.includes('could not be returned to the authorize page: tab busy')))
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true)
  login.exit(0)
  await until(() => h.refreshes === 1)
})

test('offTheFlow: claude.ai and claude.com pages outside the sign-in flow', () => {
  for (const url of ['https://claude.ai/new', 'https://claude.ai/', 'https://claude.com/settings', 'https://claude.ai/loginx', 'https://platform.claude.com/dashboard']) {
    assert.equal(offTheFlow(url), true, url)
  }
  for (const url of [
    'https://claude.ai/login', 'https://claude.ai/login/sso', 'https://claude.ai/magic-link#t', 'https://claude.com/cai/oauth/authorize?state=s',
    'https://platform.claude.com/oauth/code/callback?code=a&state=s', 'https://example.com/new', 'http://claude.ai/new', 'not a url', 'https://claude.ai/api/x', 'https://claude.ai/verify',
  ]) {
    assert.equal(offTheFlow(url), false, url)
  }
})

test('a second click for the same account while its tab is open switches to that tab and starts nothing', async () => {
  const { h } = tabAt()
  const first = await openRemoteTab(h, null)
  const again = await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.deepEqual(again, { ok: true, message: 'Sign-in already open — switched to it' })
  assert.equal(h.spawns.length, 1, 'no new login')
  assert.deepEqual(first.signals, [], 'the running sign-in is not restarted')
  const focus = callsWith(h, 'tab switch')
  assert.equal(focus.length, 2, 'once when the tab opened, once for the second click')
  for (const c of focus) {
    assert.ok(c.args.includes('--focus'))
    assert.equal(argAfter(c, '--worktree'), WORKSPACE)
  }
  first.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('a second click for another account is a new sign-in: the running one is cancelled', async () => {
  const { h } = tabAt()
  const first = await openRemoteTab(h, null)
  const next = await h.jobs.start({ host: DEV, settings: SETTINGS, account: 'a@example.com' })
  assert.equal(next.message, 'Signing in a@example.com in Orca\'s browser — sign in, then approve Claude Code')
  assert.deepEqual(first.signals, ['SIGTERM'])
  first.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
})

test('the window is 30 minutes: the remote login is wrapped in timeout 1830 and the job gives up after 30 minutes', async () => {
  assert.equal(REMOTE_LOGIN_TIMEOUT_S, 1830)
  assert.equal(LOGIN_TIMEOUT_MS, 30 * 60 * 1000)
  const { h } = tabAt()
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  assert.match(h.spawns[0].args.at(-1), /exec timeout -k 5 1830 /)
  h.clock.fire(LOGIN_TIMEOUT_MS)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
})
