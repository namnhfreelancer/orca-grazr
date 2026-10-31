import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELAY_POLL_MS } from '../lib/signin.mjs'
import { ACTION_CAP, RESTART_CAP } from '../lib/signin-page.mjs'
import { CALLBACK, NOW, ORCA, URL, WORKSPACE, argAfter, assertCleaned, callsWith, harness, json, openRemoteTab, until } from './support/signin-harness.mjs'

const ACCOUNT = 'a@b.io'
const ORIGIN = 'https://claude.ai/login?email=a%40b.io&selectAccount=true'
const EMAIL_EMPTY = 'textbox "Email" [required, ref=e8]:\nbutton "Continue with email" [ref=e10]\nbutton "Continue with Google" [ref=e12]'
const EMAIL_FILLED = 'textbox "Email" [required, ref=e8]: a@b.io\nbutton "Continue with email" [ref=e10]'
const LINK_SENT = 'text: To continue, click the link sent to a@b.io\nbutton "Enter verification code" [ref=e11]'
const CODE_BOX = 'textbox "Login code" [ref=e14]:\nbutton "Verify email address" [ref=e15]'
const CONSENT = 'heading "Claude Code" [level=1, ref=e3]\nbutton "Cancel" [ref=e19]\nbutton "Authorize" [ref=e20]'
const CONSENT_URL = 'https://claude.com/cai/oauth/authorize?code=1&state=s'
const MAGIC = 'https://claude.ai/magic-link#token'

// The relay polls once on its own as soon as it starts: a test waits for that first poll (on a quiet screen) before it
// moves the screen, so every later poll is one the test asked for.
async function settle(h) {
  await until(() => h.clock.count(RELAY_POLL_MS) === 1)
}

// One poll of the relay: fires the armed poll and waits for the next one to be armed, which is when it has finished.
async function poll(h) {
  await until(() => h.clock.hasTimer(RELAY_POLL_MS))
  const before = h.clock.count(RELAY_POLL_MS)
  h.clock.fire(RELAY_POLL_MS)
  await until(() => h.clock.count(RELAY_POLL_MS) === before + 1)
}

// The poll that finds the callback sends the code and ends the relay: no poll is armed after it.
async function relayed(h, login) {
  await until(() => h.clock.hasTimer(RELAY_POLL_MS))
  h.clock.fire(RELAY_POLL_MS)
  await until(() => login.stdin.written.length === 1)
}

// A harness whose tab shows page.url. Its snapshot is h.screen.snapshot, and it starts blank.
function signinAt(url, extra = {}) {
  const page = { url }
  const h = harness({
    nowMs: NOW.getTime(),
    ...extra,
    overrides: {
      'tab show': () => ({ stdout: json({ ok: true, result: { tab: { url: page.url } } }) }),
      ...(extra.overrides ?? {}),
    },
  })
  return { h, page }
}

// Starts the sign-in on a quiet screen and waits for the relay's first poll, so the test drives every poll after it.
async function start(h, account) {
  const login = await openRemoteTab(h, account)
  await settle(h)
  return login
}

const fills = (h) => callsWith(h, 'fill --page')
const clicks = (h) => callsWith(h, 'click --page')
const elementOf = (c) => argAfter(c, '--element')
const snapshots = (h) => callsWith(h, 'snapshot --page').length
const restarts = (h) => callsWith(h, 'goto')
const logged = (h, text) => h.logs.filter((m) => m.includes(text)).length
const finish = async (h, login) => {
  login.exit(0)
  await until(() => h.refreshes === 1)
}

test('a re-authentication walks the whole sign-in: fill the e-mail, Continue, open the code box, then the code box is left alone', async () => {
  const { h, page } = signinAt(ORIGIN)
  const login = await start(h, ACCOUNT)

  h.screen.snapshot = EMAIL_EMPTY
  const before = snapshots(h)
  await poll(h)
  assert.equal(fills(h).length, 1)
  assert.equal(elementOf(fills(h)[0]), 'e8')
  assert.equal(argAfter(fills(h)[0], '--value'), ACCOUNT)
  assert.equal(clicks(h).length, 0, 'the e-mail is filled first, and continued on the next poll')
  assert.equal(snapshots(h) - before, 2, 'a fresh snapshot is read right before the fill')

  h.screen.snapshot = EMAIL_FILLED
  await poll(h)
  assert.equal(clicks(h).length, 1)
  assert.equal(elementOf(clicks(h)[0]), 'e10')
  assert.equal(fills(h).length, 1, 'no second fill once the e-mail is right')

  h.screen.snapshot = LINK_SENT
  await poll(h)
  assert.equal(elementOf(clicks(h)[1]), 'e11')

  h.screen.snapshot = CODE_BOX
  await poll(h)
  await poll(h)
  assert.equal(fills(h).length, 1, 'the code box is never typed into')
  assert.equal(clicks(h).length, 2, 'nothing is clicked on the code box')
  assert.equal(h.published.length, 1, 'the code toast comes once')
  assert.deepEqual(h.published[0], {
    title: 'devbox: sign-in needs the login code',
    body: "Enter the login code from the e-mail to a@b.io in Orca's tab. Open the e-mail link on another device (e.g. your phone), not on this Mac.",
  })

  page.url = CALLBACK
  await relayed(h, login)
  assert.deepEqual(login.stdin.written, ['abc123#s\n'], 'the code reaches the login through the callback, as before')
  await finish(h, login)
  assert.equal(h.published.at(-1).title, 'devbox: signed in')
  assertCleaned(h, { dir: '/var/folders/t/tmp.1', page: 'page-1' })
})

test('an add-account sign-in never fills or continues the e-mail: the user types it, and the code toast names the new account', async () => {
  const { h } = signinAt(ORIGIN)
  const login = await start(h, null)
  h.screen.snapshot = EMAIL_EMPTY
  await poll(h)
  await poll(h)
  assert.equal(fills(h).length, 0)
  assert.equal(clicks(h).length, 0)
  h.screen.snapshot = CODE_BOX
  await poll(h)
  assert.equal(h.published.length, 1)
  assert.match(h.published[0].body, /to the new account in Orca's tab/)
  await finish(h, login)
})

test('the same action is taken at most ACTION_CAP times on one page state, then the step waits', async () => {
  const { h } = signinAt(ORIGIN)
  const login = await start(h, ACCOUNT)
  h.screen.snapshot = EMAIL_FILLED
  for (let i = 0; i < ACTION_CAP + 2; i++) await poll(h)
  assert.equal(clicks(h).length, ACTION_CAP)
  assert.ok(clicks(h).every((c) => elementOf(c) === 'e10'))
  await finish(h, login)
})

test('a fill that leaves the e-mail page as it was is repeated at most ACTION_CAP times', async () => {
  const { h } = signinAt(ORIGIN)
  const login = await start(h, ACCOUNT)
  h.screen.snapshot = EMAIL_EMPTY
  for (let i = 0; i < ACTION_CAP + 2; i++) await poll(h)
  assert.equal(fills(h).length, ACTION_CAP)
  await finish(h, login)
})

test('the consent is clicked once and logged once; later polls act on nothing', async () => {
  const { h, page } = signinAt(CONSENT_URL)
  const login = await start(h, ACCOUNT)
  h.screen.snapshot = CONSENT
  for (let i = 0; i < 4; i++) await poll(h)
  assert.equal(clicks(h).length, 1)
  assert.equal(elementOf(clicks(h)[0]), 'e20')
  assert.equal(logged(h, 'approved Claude Code access'), 1)
  assert.equal(fills(h).length, 0)
  page.url = CALLBACK
  await relayed(h, login)
  await finish(h, login)
})

test('a magic-link tab is sent back to the start with one goto, and the user is told to open the link on another device', async () => {
  const { h, page } = signinAt(MAGIC)
  // The first poll on the magic-link page already sends the tab back to the start.
  const login = await start(h, ACCOUNT)
  assert.equal(restarts(h).length, 1)
  const [goto] = restarts(h)
  assert.equal(argAfter(goto, '--page'), 'page-1')
  assert.equal(argAfter(goto, '--worktree'), WORKSPACE)
  assert.equal(argAfter(goto, '--url'), URL)
  assert.equal(goto.line.includes('--environment'), false)
  assert.equal(h.published.length, 1)
  assert.equal(h.published[0].title, 'devbox: sign-in: open the link on another device')
  assert.match(h.published[0].body, /sent back to the start of the sign-in/)

  // Back at the login, the e-mail step runs again. The code toast is not repeated for the new box.
  page.url = ORIGIN
  h.screen.snapshot = EMAIL_EMPTY
  await poll(h)
  assert.equal(fills(h).length, 1)
  assert.equal(h.published.length, 1)
  await finish(h, login)
})

test('magic-link restarts stop at RESTART_CAP, and the toast comes once', async () => {
  const { h } = signinAt(MAGIC)
  const login = await start(h, ACCOUNT)
  for (let i = 0; i < RESTART_CAP + 2; i++) await poll(h)
  assert.equal(restarts(h).length, RESTART_CAP)
  assert.equal(h.published.length, 1)
  await finish(h, login)
})

test('a page off the sign-in flow is never stepped: the existing steer returns it, and no fill or click is made', async () => {
  const { h } = signinAt('https://claude.ai/new')
  const login = await start(h, ACCOUNT)
  h.screen.snapshot = EMAIL_EMPTY
  await poll(h)
  assert.equal(fills(h).length + clicks(h).length, 0)
  assert.equal(restarts(h).length, 1)
  assert.equal(argAfter(restarts(h)[0], '--url'), URL)
  await finish(h, login)
})

test('a sign-in step that throws is logged, and the relay goes on polling', async () => {
  let fail = true
  const { h } = signinAt(ORIGIN, {
    overrides: {
      snapshot: () => {
        if (fail) throw new Error('orca hung')
        return { stdout: json({ ok: true, result: { snapshot: EMAIL_EMPTY } }) }
      },
    },
  })
  const login = await start(h, ACCOUNT)
  assert.equal(logged(h, 'a sign-in step failed: orca hung'), 1, h.logs.join(' | '))
  fail = false
  await poll(h)
  assert.equal(fills(h).length, 1, 'the next poll steps again')
  await finish(h, login)
})

test('an unreadable snapshot is logged once, and the sign-in carries on', async () => {
  const { h } = signinAt(ORIGIN, {
    overrides: { snapshot: () => ({ code: 1, stdout: json({ ok: false, error: { message: 'no tab' } }) }) },
  })
  const login = await start(h, ACCOUNT)
  for (let i = 0; i < 3; i++) await poll(h)
  assert.equal(logged(h, 'could not be read for its steps: no tab'), 1)
  assert.equal(fills(h).length + clicks(h).length, 0)
  await finish(h, login)
})

test('every step runs on this Mac through the Orca CLI, in the tab the sign-in opened', async () => {
  const { h } = signinAt(ORIGIN)
  const login = await start(h, ACCOUNT)
  h.screen.snapshot = EMAIL_EMPTY
  await poll(h)
  const steps = h.calls.filter((c) => c.line.includes('snapshot --page') || c.line.includes('fill --page'))
  assert.ok(steps.length >= 3)
  assert.ok(steps.every((c) => c.bin === ORCA && argAfter(c, '--page') === 'page-1' && !c.args.includes('--environment')))
  await finish(h, login)
})
