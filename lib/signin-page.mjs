import { toast } from './toast.mjs'

// The sign-in page steps: what the accessibility snapshot of the sign-in tab shows, and the one step that comes next.
// Nothing here types a code or proves an identity. The e-mail is filled only for a re-authentication, and the consent
// button is clicked once. The stateful part (counts, toasts, the fresh snapshot) lives in createStepper.

// A kind of page state may take the same action this many times, and no more.
export const ACTION_CAP = 3
// A sign-in whose e-mail link was opened in its own tab is sent back to the start this many times, at most.
export const RESTART_CAP = 3
const CONSENT = /^(authorize|allow|approve)$/i
const CODE_BOX = 'Login code'

// One line of the snapshot: `textbox "Email" [required, ref=e8]: you@example.com`, `button "Continue" [ref=e10]`,
// or `text: some words`. Only the ref in the bracket is used to act; the value is the text after the colon.
const LINE = /^\s*(?:-\s*)?([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*)\])?(?::\s?(.*))?\s*$/
const REF = /\bref=(e\d+)\b/

// The snapshot as { role, name, ref, value } entries. A line that does not parse is skipped.
export function parseSnapshot(text) {
  const elements = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(LINE)
    if (m === null) continue
    const [, role, rawName, attrs, rawValue] = m
    const ref = attrs?.match(REF)?.[1] ?? null
    elements.push({
      role: role.toLowerCase(),
      name: rawName === undefined ? null : rawName.replace(/\\(.)/g, '$1').trim(),
      ref,
      value: rawValue === undefined ? '' : rawValue.trim(),
    })
  }
  return elements
}

const find = (elements, role, name) => elements.find((e) => e.role === role && e.name === name)
const sameMail = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
// An action needs a ref to act on; an element without one is seen (for its presence) but never acted on.
const act = (id, element) => (element?.ref ? { id, ref: element.ref } : null)

// The step for this snapshot: { kind, act, codeBox }. kind is one of code, email, link-sent, consent or other. act is
// null or { id, ref }, where id is fill-email, continue, open-code or approve. consented is true once the consent was
// clicked; a consent page then has nothing left to do.
export function planStep(elements, { account = null, consented = false } = {}) {
  if (elements.some((e) => e.role === 'textbox' && e.name === CODE_BOX)) return { kind: 'code', act: null, codeBox: true }
  const email = find(elements, 'textbox', 'Email')
  const continueEmail = find(elements, 'button', 'Continue with email')
  if (email && continueEmail) {
    // An add-account sign-in leaves the e-mail to the user.
    if (account === null) return { kind: 'email', act: null, codeBox: false }
    if (!sameMail(email.value, account)) return { kind: 'email', act: act('fill-email', email), codeBox: false }
    return { kind: 'email', act: act('continue', continueEmail), codeBox: false }
  }
  const openCode = find(elements, 'button', 'Enter verification code')
  if (openCode) return { kind: 'link-sent', act: act('open-code', openCode), codeBox: false }
  const consent = elements.find((e) => e.role === 'button' && CONSENT.test(e.name ?? ''))
  if (consent) return { kind: 'consent', act: consented ? null : act('approve', consent), codeBox: false }
  return { kind: 'other', act: null, codeBox: false }
}

// A tab's address is on the magic-link page: the e-mail link was opened in this tab, which does not sign it in.
export function isMagicLink(url) {
  try {
    const path = new URL(url).pathname
    return path === '/magic-link' || path.startsWith('/magic-link/')
  } catch {
    return false
  }
}

export const codeToast = (host, account) => toast(
  host.name,
  'sign-in needs the login code',
  `Enter the login code from the e-mail to ${account ?? 'the new account'} in Orca's tab. Open the e-mail link on another device (e.g. your phone), not on this Mac.`,
)

export const magicLinkToast = (host) => toast(
  host.name,
  'sign-in: open the link on another device',
  "The e-mail link opened on this Mac cannot sign Orca's tab in, so the tab was sent back to the start of the sign-in. Open the link on another device (e.g. your phone), not on this Mac.",
)

const pathOf = (url) => new URL(url).pathname

// Makes the sign-in steps for one job. call(args) runs an Orca command and answers { ok, result, message }; page and
// workspace name the tab; notify shows a toast; log writes a line that never holds a secret. step(url) runs at most one
// action for a tab address and answers 'acted' or 'quiet'. It never throws.
export function createStepper({ call, log, notify, host, page, workspace, account, authorizeUrl, isSignInPage }) {
  let stateKey = null
  let counts = {}
  let consented = false
  let codeToasted = false
  let magicToasted = false
  let restarts = 0
  let unreadWarned = false

  // The snapshot's elements, or null when the tab cannot be read (said once, in the log).
  async function read() {
    const shown = await call(['snapshot', '--page', page])
    if (shown.ok && typeof shown.result?.snapshot === 'string') return parseSnapshot(shown.result.snapshot)
    if (!unreadWarned) {
      unreadWarned = true
      log(`grazr sign-in: the sign-in tab could not be read for its steps: ${shown.message ?? 'no snapshot'}`)
    }
    return null
  }

  async function perform(step) {
    if (step.id === 'approve') consented = true
    const reply = await call(step.id === 'fill-email'
      ? ['fill', '--page', page, '--element', step.ref, '--value', account]
      : ['click', '--page', page, '--element', step.ref])
    const done = {
      'fill-email': ['filled the account\'s e-mail in the sign-in tab', 'the e-mail could not be filled'],
      continue: ['pressed Continue with email', 'Continue with email reported an error'],
      'open-code': ['opened the login code box in the sign-in tab', 'the login code box could not be opened'],
      approve: ['approved Claude Code access', 'the approval click reported an error; the page is checked again'],
    }[step.id]
    log(`grazr sign-in: ${reply.ok ? done[0] : `${done[1]}: ${reply.message ?? 'no answer'}`}`)
    return 'acted'
  }

  async function restart() {
    if (restarts >= RESTART_CAP) return 'quiet'
    restarts++
    if (!magicToasted) {
      magicToasted = true
      notify(magicLinkToast(host))
    }
    const moved = await call(['goto', '--page', page, '--worktree', workspace, '--url', authorizeUrl])
    log(moved.ok
      ? `grazr sign-in: the e-mail link was opened on this Mac; the tab was sent back to the start (${restarts} of ${RESTART_CAP})`
      : `grazr sign-in: the tab could not be sent back to the start: ${moved.message ?? 'no answer'}`)
    return 'acted'
  }

  return async function step(url) {
    if (typeof url !== 'string' || !isSignInPage(url)) return 'quiet'
    if (isMagicLink(url)) return restart()
    const elements = await read()
    if (elements === null) return 'quiet'
    const planned = planStep(elements, { account, consented })
    if (planned.codeBox && !codeToasted) {
      codeToasted = true
      notify(codeToast(host, account))
    }
    if (planned.act === null) return 'quiet'
    // The state is the page kind on its path: a new kind (or path) starts with fresh counts.
    const key = `${planned.kind}|${pathOf(url)}`
    if (key !== stateKey) {
      stateKey = key
      counts = {}
    }
    if ((counts[planned.act.id] ?? 0) >= ACTION_CAP) return 'quiet'
    // Refs change on every render: the action is re-planned on a fresh snapshot, and acts only on the same step.
    const fresh = await read()
    if (fresh === null) return 'quiet'
    const again = planStep(fresh, { account, consented })
    if (again.act === null || again.act.id !== planned.act.id) return 'quiet'
    counts[again.act.id] = (counts[again.act.id] ?? 0) + 1
    return perform(again.act)
  }
}
