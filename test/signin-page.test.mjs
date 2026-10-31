import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeToast, isMagicLink, magicLinkToast, parseSnapshot, planStep } from '../lib/signin-page.mjs'
import { DEV } from './support/signin-harness.mjs'

// The snapshot lines as `orca snapshot --json` prints them on the sign-in pages.
const EMAIL_EMPTY = [
  'heading "Log in" [level=1, ref=e2]',
  'text: Continue with your Claude.ai account to authenticate connections',
  'textbox "Email" [required, ref=e8]:',
  'button "Continue with email" [ref=e10]',
  'button "Continue with Google" [ref=e12]',
  'button "Continue with Apple" [ref=e13]',
].join('\n')
const EMAIL_FILLED = EMAIL_EMPTY.replace('[required, ref=e8]:', '[required, ref=e8]: You@Example.com ')
const LINK_SENT = [
  'text: To continue, click the link sent to a@b.io',
  'button "Enter verification code" [ref=e11]',
].join('\n')
const CODE_BOX = [
  'text: To continue, click the link sent to a@b.io',
  'textbox "Login code" [ref=e14]:',
  'button "Verify email address" [ref=e15]',
].join('\n')
const CONSENT = (label) => `heading "Claude Code" [level=1, ref=e3]\nbutton "Cancel" [ref=e19]\nbutton "${label}" [ref=e20]`

test('parseSnapshot reads the role, the quoted name, the ref in the bracket and the value after the colon', () => {
  const [, , email, cont] = parseSnapshot(EMAIL_FILLED)
  assert.deepEqual(email, { role: 'textbox', name: 'Email', ref: 'e8', value: 'You@Example.com' })
  assert.deepEqual(cont, { role: 'button', name: 'Continue with email', ref: 'e10', value: '' })
  const [required] = parseSnapshot('textbox "Email" [required, ref=e8]: you@example.com')
  assert.equal(required.ref, 'e8', 'the ref is found beside other attributes, not only as [ref=')
  assert.equal(required.value, 'you@example.com')
})

test('parseSnapshot skips lines it cannot read and keeps elements without a ref (seen, never acted on)', () => {
  const parsed = parseSnapshot('\n\n%%% junk %%%\nbutton "Authorize"\n- button "Allow" [ref=e9]\n')
  assert.deepEqual(parsed.map((e) => [e.role, e.name, e.ref]), [['button', 'Authorize', null], ['button', 'Allow', 'e9']])
  assert.deepEqual(parseSnapshot(undefined), [])
})

test('a re-authentication on an empty e-mail page fills the account e-mail first, and never the code', () => {
  const plan = planStep(parseSnapshot(EMAIL_EMPTY), { account: 'a@b.io' })
  assert.deepEqual(plan, { kind: 'email', act: { id: 'fill-email', ref: 'e8' }, codeBox: false })
})

test('the e-mail is compared without case or spaces: the same address is continued, another is refilled', () => {
  assert.deepEqual(planStep(parseSnapshot(EMAIL_FILLED), { account: 'you@example.com' }).act, { id: 'continue', ref: 'e10' })
  assert.deepEqual(planStep(parseSnapshot(EMAIL_FILLED), { account: 'other@example.com' }).act, { id: 'fill-email', ref: 'e8' })
})

test('an add-account sign-in leaves the e-mail to the user: the email page has no action at all', () => {
  assert.deepEqual(planStep(parseSnapshot(EMAIL_EMPTY), { account: null }), { kind: 'email', act: null, codeBox: false })
  assert.deepEqual(planStep(parseSnapshot(EMAIL_FILLED), { account: null }).act, null)
})

test('the link-sent page opens the code box; Google, Apple and other buttons are never acted on', () => {
  assert.deepEqual(planStep(parseSnapshot(LINK_SENT), { account: 'a@b.io' }), { kind: 'link-sent', act: { id: 'open-code', ref: 'e11' }, codeBox: false })
  const other = parseSnapshot('button "Continue with Google" [ref=e12]\nbutton "Try Claude" [ref=e30]\nbutton "Download" [ref=e31]')
  assert.deepEqual(planStep(other, { account: 'a@b.io' }), { kind: 'other', act: null, codeBox: false })
})

test('a page with the Login code box is the code step: nothing is acted on, and the box is never a fill target', () => {
  for (const account of ['a@b.io', null]) {
    const plan = planStep(parseSnapshot(CODE_BOX), { account })
    assert.deepEqual(plan, { kind: 'code', act: null, codeBox: true })
  }
  // Even with the e-mail page's controls still visible, a code box means the code step.
  const both = planStep(parseSnapshot(`${EMAIL_FILLED}\n${CODE_BOX}`), { account: 'a@b.io' })
  assert.equal(both.act, null)
  assert.equal(both.codeBox, true)
})

test('the consent button is Authorize, Allow or Approve in any case, and only exact names count', () => {
  for (const label of ['Authorize', 'allow', 'APPROVE']) {
    assert.deepEqual(planStep(parseSnapshot(CONSENT(label)), { account: 'a@b.io' }).act, { id: 'approve', ref: 'e20' }, label)
  }
  for (const label of ['Authorize access', 'Deny', 'Not now']) {
    assert.equal(planStep(parseSnapshot(CONSENT(label)), { account: 'a@b.io' }).act, null, label)
  }
})

test('once the consent is clicked, the consent page has no further action', () => {
  const plan = planStep(parseSnapshot(CONSENT('Authorize')), { account: 'a@b.io', consented: true })
  assert.deepEqual(plan, { kind: 'consent', act: null, codeBox: false })
})

test('an element with no ref is seen but gives no action', () => {
  assert.equal(planStep(parseSnapshot('textbox "Email"\nbutton "Continue with email"'), { account: 'a@b.io' }).act, null)
})

test('isMagicLink matches the magic-link page and its sub-pages only', () => {
  assert.equal(isMagicLink('https://claude.ai/magic-link#token'), true)
  assert.equal(isMagicLink('https://claude.ai/magic-link/'), true)
  assert.equal(isMagicLink('https://claude.ai/magic-links'), false)
  assert.equal(isMagicLink('https://claude.ai/login'), false)
  assert.equal(isMagicLink('not a url'), false)
})

test('the code and magic-link toasts name the account and the other device; the code is never in them', () => {
  assert.deepEqual(codeToast(DEV, 'a@b.io'), {
    title: 'devbox: sign-in needs the login code',
    body: "Enter the login code from the e-mail to a@b.io in Orca's tab. Open the e-mail link on another device (e.g. your phone), not on this Mac.",
  })
  assert.equal(codeToast(DEV, null).body.startsWith("Enter the login code from the e-mail to the new account in Orca's tab."), true)
  const magic = magicLinkToast(DEV)
  assert.equal(magic.title, 'devbox: sign-in: open the link on another device')
  assert.match(magic.body, /another device \(e\.g\. your phone\), not on this Mac/)
})
