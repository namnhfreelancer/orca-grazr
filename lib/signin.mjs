import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { createRunner, ok as commandOk } from './runner.mjs'
import { claudeBinOf, isRemote } from './hosts.mjs'
import { expandTilde } from './paths.mjs'
import { toast, failureBody } from './toast.mjs'
import { describe, describeFailure } from './errors.mjs'
import { quote, quoteTilde } from './shell-quote.mjs'
import { createStepper } from './signin-page.mjs'

// Claude must print its sign-in address within this long, or the job gives up.
export const URL_TIMEOUT_MS = 30 * 1000
// A sign-in not finished within this long is abandoned: the login is stopped and discarded. The same long a tab
// address may stay unchanged before the sign-in is treated as abandoned.
export const LOGIN_TIMEOUT_MS = 30 * 60 * 1000
// SIGTERM first so claude can clean up; SIGKILL only if it ignores that.
export const KILL_GRACE_MS = 2000
// After SIGKILL, a child (or a grandchild that holds its pipes open) may still never emit close; the job then gives up.
export const HARD_DEADLINE_MS = 5000
// Any line of child output that reaches a toast or a message is cut to this many characters.
export const LINE_MAX = 200
const STEP_TIMEOUT_MS = 20000
const ORCA_TIMEOUT_MS = 15000
// The remote login is wrapped in timeout(1) at this many seconds, so it ends on the remote host too.
export const REMOTE_LOGIN_TIMEOUT_S = 1830
// claude ignores SIGTERM, so timeout(1) sends SIGKILL this many seconds after its TERM.
export const REMOTE_KILL_AFTER_S = 5
// The tab's address is read this often while the sign-in is waiting for its code.
export const RELAY_POLL_MS = 1500
// A tab that has left the sign-in is returned to the authorize page at most this often, and this many times per sign-in.
export const STEER_GAP_MS = 10 * 1000
export const STEER_MAX = 5
// The paths of the sign-in flow on claude.ai and claude.com. A page off these paths, after the user is signed in, is off the flow.
const FLOW_PATHS = ['/login', '/magic-link', '/oauth', '/cai/oauth', '/api', '/verify', '/sso', '/auth']
const ALREADY_OPEN = 'Sign-in already open — switched to it'
const signingIn = (account) => `Signing in ${account ?? 'a new account'} in Orca's browser — sign in, then approve Claude Code`
// A sign-in address printed without its newline is taken once the output has been quiet this long.
const URL_QUIET_MS = 500
const NO_WORKSPACE = 'Sign-in needs a local project in Orca: add any folder on this Mac as a project (Orca › Add project), then click again'
const NO_REMOTE_HOST = 'Sign-in needs a remote host to log in on'
// The remote login prints its shell's pid first, so a stop can end the remote process group (ssh hang-up does not reach it).
const PID_LINE = /grazr-pid:(\d+)\r?\n/
// The remote kill is best effort and short: a host that does not answer is left to its own timeout.
const KILL_TIMEOUT_MS = 5000
// The sign-in address: a line that starts with `visit:`. Whether it ends in a newline is checked by the caller.
const SIGNIN_URL = /visit:\s*(https:\/\/\S+)(\r?\n)?/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Only these sites may be opened in Orca's browser for a sign-in, and only over https.
const SIGNIN_SITES = ['claude.ai', 'claude.com', 'anthropic.com']
// Claude's manual flow ends on this page: the code and state in its query are the answer, written to the login's stdin.
const CALLBACK_HOST = 'platform.claude.com'
const CALLBACK_PATH = '/oauth/code/callback'
const CODE_CHARS = /^[A-Za-z0-9._~-]+$/
// A code or state longer than this is refused, whatever it holds.
const CODE_MAX = 512
// Consecutive failed reads of the sign-in tab's address before the tab is taken as closed.
export const TAB_READ_FAILURES = 5

// Child output is clipped before it is shown: one line, at most LINE_MAX characters, ending in an ellipsis when cut.
export function clip(text) {
  const s = String(text ?? '')
  return s.length <= LINE_MAX ? s : `${s.slice(0, LINE_MAX - 1)}…`
}

const lastLine = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null

const asObject = (text) => {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// Orca prints pretty-printed JSON over several lines; the engine prints one line. The whole output is tried first,
// then its last line.
function parseReply(stdout) {
  const text = (stdout ?? '').trim()
  return asObject(text) ?? asObject(lastLine(text) ?? '')
}

// Whether a sign-in address is https on one of the sign-in sites, or a subdomain of one.
export function isSignInUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && SIGNIN_SITES.some((site) => parsed.hostname === site || parsed.hostname.endsWith(`.${site}`))
}

// The code and state the browser was sent to after the sign-in was approved, as { code, state }, or null. Only the
// callback page itself counts; its state must equal the state of the authorize address the job opened; and a code or
// state with anything but plain token characters, or longer than CODE_MAX, is refused.
export function callbackCode(url, expectedState) {
  if (typeof url !== 'string') return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== CALLBACK_HOST || parsed.pathname !== CALLBACK_PATH) return null
  const code = parsed.searchParams.get('code')
  const state = parsed.searchParams.get('state')
  if (!code || !state || typeof expectedState !== 'string' || expectedState === '') return null
  if (state !== expectedState || code.length > CODE_MAX || state.length > CODE_MAX) return null
  return CODE_CHARS.test(code) && CODE_CHARS.test(state) ? { code, state } : null
}

// Whether a tab address is on claude.ai or claude.com, outside the sign-in flow: not on one of FLOW_PATHS, and not the
// platform callback that the code relay reads. Any other address (another site) is not steered.
export function offTheFlow(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname
  const onClaude = parsed.protocol === 'https:' && ['claude.ai', 'claude.com'].some((site) => host === site || host.endsWith(`.${site}`))
  if (!onClaude) return false
  if (host === CALLBACK_HOST && parsed.pathname === CALLBACK_PATH) return false
  return !FLOW_PATHS.some((flow) => parsed.pathname === flow || parsed.pathname.startsWith(`${flow}/`))
}

// Brings the sign-in tab to the front in its workspace. Best effort: a failure is logged and is never fatal.
async function focusTab(ctx, page, workspace, log) {
  const focused = await orcaCall(ctx, ['tab', 'switch', '--page', page, '--worktree', workspace, '--focus'])
  if (!focused.ok) log(`grazr sign-in: the sign-in tab could not be brought to the front: ${focused.message}`)
  return focused.ok
}

// The profile label for an account: one isolated profile per account, reused by every sign-in for it.
export const profileLabel = (account) => (account ? `grazr · ${account}` : 'grazr · new account')

// The configured signinHost host, when it names one; undefined otherwise.
const namedSigninHost = (settings) => (typeof settings.signinHost === 'string' && settings.signinHost !== ''
  ? settings.hosts.find((h) => h.name === settings.signinHost)
  : undefined)

// The host that runs the login: the card's own host when it is remote; for a Mac card, signinHost when it names a remote
// host, else the first remote host. Null when there is none. The login needs no browser of its own.
export function loginHostFor(settings, host) {
  if (isRemote(host)) return host
  const named = namedSigninHost(settings)
  if (named && isRemote(named)) return named
  return settings.hosts.find((h) => isRemote(h)) ?? null
}

// One Orca CLI call on this Mac, with --json. Never rejects: a failure is { ok: false, message }.
export async function orcaCall({ exec, settings, homedir }, args) {
  const bin = expandTilde(settings.orcaBin, homedir)
  const result = await exec([bin, ...args, '--json'], { timeoutMs: ORCA_TIMEOUT_MS })
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) return { ok: true, result: reply.result }
  const message = typeof reply?.error?.message === 'string' ? reply.error.message : result.spawnError ? `could not run ${bin}` : 'no answer from Orca'
  return { ok: false, message: clip(message) }
}

// The local Orca worktrees, read on this Mac's own runtime: { entries } or { error }. Each entry carries the selector a
// `--worktree` flag takes, its path, and the label the sign-in names (its repo's display name, else its folder).
const basename = (path) => path.split('/').filter(Boolean).at(-1) ?? path
function describeWorkspace(entry) {
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null
  const path = typeof entry.path === 'string' && entry.path !== '' ? entry.path : null
  const selector = id ? `id:${id}` : path ? `path:${path}` : null
  if (selector === null) return null
  const repo = entry.repo?.displayName ?? entry.repoDisplayName ?? null
  const label = typeof repo === 'string' && repo !== '' ? repo : path ? basename(path) : selector
  return { selector, path, label }
}
async function localWorkspaces(ctx) {
  const listed = await orcaCall(ctx, ['worktree', 'list'])
  if (!listed.ok) return { error: listed.message }
  const raw = listed.result
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.worktrees) ? raw.worktrees : []
  return { entries: list.filter((e) => e !== null && typeof e === 'object').map(describeWorkspace).filter(Boolean) }
}

// The workspace a sign-in tab opens in: signinWorkspace when set, else the first local worktree (the plugin's own folder
// first, when it is one). { workspace }, { error } when the list cannot be read, or { none } when there is no local worktree.
export async function chooseWorkspace(ctx, settings, pluginRoot) {
  const listed = await localWorkspaces(ctx)
  if (listed.error) return { error: listed.error }
  const wanted = typeof settings.signinWorkspace === 'string' && settings.signinWorkspace.trim() !== '' ? settings.signinWorkspace.trim() : null
  if (wanted !== null) {
    const match = listed.entries.find((e) => e.selector === wanted)
    return { workspace: { selector: wanted, label: match?.label ?? wanted } }
  }
  if (listed.entries.length === 0) return { none: true }
  const pick = (pluginRoot && listed.entries.find((e) => e.path === pluginRoot)) || listed.entries[0]
  return { workspace: { selector: pick.selector, label: pick.label } }
}

// Stops a remote login by its pid (from its first output line): the whole process group that shell leads. Best effort:
// a failure is logged, never thrown.
async function stopRemoteLogin({ exec, settings, log }, login, pid) {
  try {
    const killed = await exec([settings.sshBin, ...settings.sshOptions, login.ssh, `kill -KILL -- -${pid}`], { timeoutMs: KILL_TIMEOUT_MS })
    if (!commandOk(killed)) log(`grazr sign-in: the remote login on ${login.name} was not stopped`)
  } catch (err) {
    log(`grazr sign-in: stopping the remote login failed: ${describe(err)}`)
  }
}

// yyyy-mm-dd hh:mm in local time, for the label of a fresh profile.
const stamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The profile lists on this Mac, as { profiles } or { error }.
async function listProfiles(ctx) {
  const listed = await orcaCall(ctx, ['tab', 'profile', 'list'])
  return listed.ok ? { profiles: listed.result?.profiles ?? [] } : { error: listed.message }
}

// The isolated profile for a sign-in. A re-authentication reuses the account's profile, found by its label or created
// once. An add-account sign-in creates a fresh one: its label carries the time and a random suffix, and its id is the
// one listed after the create that was not listed before it. created is set as soon as Orca has made the profile,
// so a job that ends early still deletes it (by id, or by label when the id could not be read).
async function profileFor(ctx, account, now, suffix) {
  if (account !== null) {
    const label = profileLabel(account)
    const listed = await listProfiles(ctx)
    if (listed.error) return { ok: false, message: listed.error }
    const existing = listed.profiles.find((p) => p?.label === label)
    if (typeof existing?.id === 'string') return { ok: true, id: existing.id, fresh: false }
    const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--label', label, '--scope', 'isolated'])
    if (!made.ok) return { ok: false, message: made.message }
    const again = await listProfiles(ctx)
    if (again.error) return { ok: false, message: again.error }
    const id = again.profiles.find((p) => p?.label === label)?.id
    return typeof id === 'string' ? { ok: true, id, fresh: false } : { ok: false, message: `Orca did not list the profile ${label}` }
  }
  const before = await listProfiles(ctx)
  if (before.error) return { ok: false, message: before.error }
  const known = new Set(before.profiles.map((p) => p?.id))
  const label = `${profileLabel(null)} ${stamp(now())} ${suffix()}`
  const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--label', label, '--scope', 'isolated'])
  if (!made.ok) return { ok: false, message: made.message }
  const created = { label, id: null }
  const after = await listProfiles(ctx)
  if (after.error) return { ok: false, message: after.error, fresh: true, created }
  const id = after.profiles.find((p) => p?.label === label && typeof p.id === 'string' && !known.has(p.id))?.id
  if (typeof id !== 'string') return { ok: false, message: `Orca did not list the profile ${label}`, fresh: true, created }
  created.id = id
  return { ok: true, id, fresh: true, created }
}

// The id of the one profile with this label, found again by label; null when there is none or more than one.
async function profileIdByLabel(ctx, label) {
  const listed = await listProfiles(ctx)
  if (listed.error) return null
  const matches = listed.profiles.filter((p) => p?.label === label && typeof p.id === 'string')
  return matches.length === 1 ? matches[0].id : null
}

// Closes every tab on this Mac whose address is the sign-in address. Best effort: it never throws.
async function closeTabsAt(ctx, url) {
  const listed = await orcaCall(ctx, ['tab', 'list', '--worktree', 'all'])
  if (!listed.ok) return
  for (const tab of listed.result?.tabs ?? []) {
    const page = tab?.browserPageId ?? tab?.id
    if (tab?.url === url && typeof page === 'string') await orcaCall(ctx, ['tab', 'close', '--page', page])
  }
}

// The remote login command. CLAUDE_CONFIG_DIR is set for the whole line. setsid makes the shell the leader of its own
// process group, so its pid names the group. The shell echoes its pid, then execs timeout(1) around claude: timeout
// sends SIGKILL after its TERM because claude ignores TERM. The claude path keeps its ~/ expansion, which the inner
// shell performs.
export function remoteLoginCommand({ dir, claudeBin, args }) {
  const inner = ['echo grazr-pid:$$;', 'exec', 'timeout', '-k', String(REMOTE_KILL_AFTER_S), String(REMOTE_LOGIN_TIMEOUT_S), quoteTilde(claudeBin), ...args.map(quote)].join(' ')
  return `CLAUDE_CONFIG_DIR=${quote(dir)} setsid sh -c ${quote(inner)}`
}

// Starts claude's login on the login host over plain ssh (no pty: claude's manual flow reads its code from stdin, and a
// pty makes it print nothing). stdin is a pipe that stays open until the login ends. handle.url resolves { url } once
// claude prints its sign-in address, or { reason } when it never does (the address may arrive on stdout or stderr).
// handle.exit resolves once the ssh child has ended, with the output it printed. handle.send(text) writes to the
// login's stdin. handle.stop() kills the ssh child. Nothing here rejects.
function startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs }) {
  let resolveUrl
  let resolveExit
  const handle = {
    url: new Promise((resolve) => { resolveUrl = resolve }),
    exit: new Promise((resolve) => { resolveExit = resolve }),
    timedOut: false,
    // The remote shell's pid, once its first line has been read; null until then.
    pid: null,
    send: () => false,
    stop: () => {},
  }
  let child
  try {
    child = spawn(settings.sshBin, [...settings.sshOptions, login.ssh, command], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (spawnError) {
    resolveUrl({ reason: 'exited' })
    resolveExit({ spawnError, code: null, signal: null, timedOut: false, stderr: '', output: '' })
    return handle
  }
  const err = []
  let text = ''
  let found = false
  let settled = false
  const timer = { url: null, limit: null, grace: null, hard: null, quiet: null }
  const finish = (outcome) => {
    if (settled) return
    settled = true
    for (const t of Object.values(timer)) timers.clearTimeout(t)
    child.stdin?.destroy?.()
    resolveUrl({ reason: 'exited' })
    resolveExit({
      timedOut: handle.timedOut,
      stderr: Buffer.concat(err).toString('utf8'),
      output: text.replace(ANSI, ''),
      spawnError: null,
      code: null,
      signal: null,
      ...outcome,
    })
  }
  // Once stop() has been asked for, nothing more is written to the login.
  let stopping = false
  handle.send = (value) => {
    if (settled || stopping) return false
    try {
      child.stdin.write(value)
      return true
    } catch {
      return false
    }
  }
  handle.stop = () => {
    stopping = true
    if (settled || timer.grace) return
    child.kill('SIGTERM')
    timer.grace = timers.setTimeout(() => {
      child.kill('SIGKILL')
      // close may still never come (a grandchild holding the pipes): the job stops waiting and is released.
      timer.hard = timers.setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), HARD_DEADLINE_MS)
    }, KILL_GRACE_MS)
  }
  const foundUrl = (url) => {
    found = true
    timers.clearTimeout(timer.url)
    timers.clearTimeout(timer.quiet)
    resolveUrl({ url })
  }
  // A line with its newline is the address at once. One without is taken only after the output has been quiet.
  const scan = (final) => {
    if (found) return
    const match = text.replace(ANSI, '').match(SIGNIN_URL)
    if (match === null) return
    if (match[2] !== undefined || final) return foundUrl(match[1])
    timers.clearTimeout(timer.quiet)
    timer.quiet = timers.setTimeout(() => scan(true), URL_QUIET_MS)
  }
  const onOutput = (chunk) => {
    text = (text + chunk.toString('utf8')).slice(-8192)
    // The pid line is read on the chunk that completes it, and only a whole numeric line counts.
    if (handle.pid === null) {
      const pid = Number(text.replace(ANSI, '').match(PID_LINE)?.[1])
      if (Number.isSafeInteger(pid) && pid > 0) handle.pid = pid
    }
    scan(false)
  }
  child.stdout.on('data', onOutput)
  child.stdout.on('end', () => scan(true))
  child.stderr.on('data', (chunk) => {
    err.push(chunk)
    onOutput(chunk)
  })
  child.stderr.on('end', () => scan(true))
  // ssh may exit before reading stdin; that EPIPE is reported through close, not thrown.
  child.stdin?.on('error', () => {})
  child.on('error', (spawnError) => finish({ spawnError }))
  child.on('close', (code, signal) => finish({ code, signal }))
  timer.limit = timers.setTimeout(() => { handle.timedOut = true; handle.stop() }, loginTimeoutMs)
  timer.url = timers.setTimeout(() => { resolveUrl({ reason: 'timeout' }); handle.stop() }, urlTimeoutMs)
  return handle
}

// Polls the sign-in tab's address until it is the callback with the expected state and a code, then writes `code#state`
// to the login's stdin, once, and stops polling. Resolves 'sent'; 'ended' (the login ended, or the job was cancelled, first);
// 'idle' (the address did not change for the whole login limit); or 'closed' (the tab could not be read
// TAB_READ_FAILURES times in a row). Nothing is written once cancelled() is true. The code is never logged or shown.
function relayCode({ ctx, page, workspace, authorizeUrl, handle, timers, now, expectedState, cancelled, log, automate }) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    let lastUrl = null
    let lastChange = now()
    let failedReads = 0
    let steers = 0
    let lastSteer = null
    const finish = (outcome) => {
      if (done) return
      done = true
      timers.clearTimeout(timer)
      resolve(outcome)
    }
    handle.exit.then(() => finish('ended'))
    const poll = async () => {
      timer = null
      const shown = await orcaCall(ctx, ['tab', 'show', '--page', page])
      if (done) return
      if (!shown.ok) {
        failedReads++
        if (failedReads >= TAB_READ_FAILURES) return finish('closed')
      } else {
        failedReads = 0
      }
      const url = shown.ok && typeof shown.result?.tab?.url === 'string' ? shown.result.tab.url : null
      if (url !== null && url !== lastUrl) {
        lastUrl = url
        lastChange = now()
      }
      const callback = callbackCode(url, expectedState)
      if (callback !== null) {
        if (cancelled()) return finish('ended')
        return finish(handle.send(`${callback.code}#${callback.state}\n`) ? 'sent' : 'ended')
      }
      // A sign-in page is stepped at most once per poll (e-mail, continue, code box, approve, or the magic-link restart).
      // A failing step is logged and the poll goes on; it never ends the relay.
      let stepped = 'quiet'
      if (url !== null && !cancelled()) {
        try {
          stepped = await automate(url)
        } catch (err) {
          log(`grazr sign-in: a sign-in step failed: ${describe(err)}`)
        }
        if (done) return
      }
      // Signed in but off the flow (say, claude.ai/new): the authorize page is opened again in this tab, at most every
      // STEER_GAP_MS and STEER_MAX times in all, so the flow is not lost. A tab that was stepped is not moved this poll.
      if (stepped === 'quiet' && url !== null && offTheFlow(url) && steers < STEER_MAX && (lastSteer === null || now() - lastSteer >= STEER_GAP_MS)) {
        steers++
        lastSteer = now()
        const moved = await orcaCall(ctx, ['goto', '--page', page, '--worktree', workspace, '--url', authorizeUrl])
        if (done) return
        log(moved.ok
          ? `grazr sign-in: the tab had left the sign-in; returned it to the authorize page (${steers} of ${STEER_MAX})`
          : `grazr sign-in: the tab could not be returned to the authorize page: ${moved.message}`)
      }
      if (now() - lastChange >= LOGIN_TIMEOUT_MS) return finish('idle')
      timer = timers.setTimeout(poll, RELAY_POLL_MS)
    }
    void poll()
  })
}

const cancelledToast = (host) => toast(host.name, 'sign-in cancelled', 'A newer sign-in on this card replaced it. Nothing was enrolled.')

const notFinishedToast = (host, login) => toast(host.name, 'sign-in failed', `The login did not finish on ${login.name}.\nNothing was enrolled.`)

// A step over ssh that failed: an unreachable login host is said so; anything else shows the engine's or ssh's failure.
function stepFailedToast(host, login, result) {
  const failure = describeFailure(result)
  if (failure.kind === 'unreachable') return toast(host.name, 'sign-in failed', `${login.name} could not be reached; nothing was enrolled.`)
  return toast(host.name, 'sign-in failed', `${clip(failureBody(failure))}\nNothing was enrolled.`)
}

function loginFailedToast(host, login, exit) {
  if (exit.spawnError) return toast(host.name, 'sign-in failed', `Could not run ssh: ${clip(exit.spawnError.message)}\nNothing was enrolled.`)
  if (describeFailure({ ...exit, remote: true }).kind === 'unreachable') return toast(host.name, 'sign-in failed', `${login.name} could not be reached; nothing was enrolled.`)
  // The remote's stderr and stdout are both read, so the last line of either is the reason.
  const last = [exit.stderr, exit.output].map((t) => (t ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1)).find(Boolean)
  return toast(host.name, 'sign-in failed', `${clip(last ?? `exit ${exit.code ?? exit.signal}`)}\nNothing was enrolled.`)
}

const orcaFailedToast = (host, label, message) => toast(host.name, 'sign-in failed', `Orca's browser in the ${clip(label)} workspace could not open the sign-in: ${clip(message)}\nNothing was enrolled.`)

// The enrolment's outcome: enrolled, refused, or the engine's failure. Never includes the export itself.
function enrolToast(host, result) {
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) {
    const note = reply.unblocked === false ? '\nIt is still blocked; press Refresh on the card.' : ''
    return toast(host.name, 'signed in', `Enrolled ${clip(reply.email ?? 'the account')} on ${host.name}${note}`)
  }
  if (typeof reply?.error === 'string' && reply.error !== '') {
    return toast(host.name, 'sign-in failed', `${clip(reply.error)}\nNothing was enrolled.`)
  }
  return stepFailedToast(host, { name: host.name }, result)
}

// The e-mail the export's identity names, or null. The export itself is never kept.
function emailIn(result) {
  const identity = commandOk(result) ? parseReply(result.stdout)?.identity : null
  return typeof identity?.emailAddress === 'string' && identity.emailAddress !== '' ? identity.emailAddress : null
}

export function createSigninJobs({
  exec = execCapture,
  spawn = nodeSpawn,
  homedir = os.homedir,
  timers = { setTimeout, clearTimeout },
  log = () => {},
  publish,
  refreshPanel,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  urlTimeoutMs = URL_TIMEOUT_MS,
  now = () => new Date(),
  suffix = () => randomBytes(2).toString('hex'),
  pluginRoot = null,
}) {
  // The job holding each card's host. A host has at most one: a newer start replaces the older one.
  const active = new Map()
  // The host names with a job that has not yet released its login.
  const running = new Set()

  // Resolves at once with the outcome of the start; the job runs in the background after it.
  async function start({ host, settings, account = null }) {
    if (account !== null && account.startsWith('-')) return { ok: false, message: 'That account name cannot be used for a sign-in' }
    const login = loginHostFor(settings, host)
    if (!login) return { ok: false, message: NO_REMOTE_HOST }
    const chosen = await chooseWorkspace({ exec, settings, homedir }, settings, pluginRoot)
    if (chosen.error) return { ok: false, message: clip(chosen.error) }
    if (chosen.none) return { ok: false, message: NO_WORKSPACE }
    const { workspace } = chosen
    const current = active.get(host.name) ?? null
    if (current !== null && current.account === account && current.pageId !== null && !current.cancelled && !current.enrolling) {
      const shown = await orcaCall({ exec, settings, homedir }, ['tab', 'show', '--page', current.pageId])
      if (shown.ok) {
        await focusTab({ exec, settings, homedir }, current.pageId, current.workspace.selector, log)
        return { ok: true, message: ALREADY_OPEN }
      }
    }
    const previous = active.get(host.name) ?? null
    previous?.cancel()
    const job = {
      host, settings, account, login, workspace,
      cancelled: false, enrolling: false, dir: null, pageId: null, freshProfile: null, handle: null, loginExit: null,
      released: null, releaseDone: null, cancel: null,
    }
    job.released = new Promise((resolve) => { job.releaseDone = resolve })
    // Once the enrolment has begun the login is kept: a newer start waits for it instead.
    job.cancel = () => {
      if (job.enrolling || job.cancelled) return
      job.cancelled = true
      job.handle?.stop()
    }
    active.set(host.name, job)
    running.add(host.name)
    void execute(job, previous)
    return { ok: true, message: signingIn(account) }
  }

  // Runs the job after the one it replaces has released its login. Every path discards the login and closes the tab.
  async function execute(job, previous) {
    let outcome
    try {
      if (previous) await previous.released
      outcome = await attempt(job)
    } catch (err) {
      log(`grazr sign-in: ${describe(err)}`)
      outcome = toast(job.host.name, 'sign-in failed', 'The sign-in stopped before it finished.')
    }
    try {
      await cleanup(job)
    } catch (err) {
      log(`grazr sign-in: cleanup failed: ${describe(err)}`)
    }
    release(job)
    try {
      await publish(outcome)
    } catch (err) {
      log(`grazr sign-in: notification failed: ${describe(err)}`)
    }
    try {
      await refreshPanel()
    } catch (err) {
      log(`grazr sign-in: panel refresh failed: ${describe(err)}`)
    }
  }

  function release(job) {
    const name = job.host.name
    if (active.get(name) === job) {
      active.delete(name)
      running.delete(name)
    }
    job.releaseDone()
  }

  // A login directory is usable when it is an absolute path without NUL; quote carries any such path safely.
  const usableDir = (dir) => typeof dir === 'string' && dir.startsWith('/') && !dir.includes('\0')

  // Best effort: removes a directory mktemp printed but that is not usable, only when it is empty. Never throws.
  async function removeEmptyDir({ exec, settings }, login, dir) {
    try {
      await exec([settings.sshBin, ...settings.sshOptions, login.ssh, `rmdir -- ${quote(dir)}`], { timeoutMs: STEP_TIMEOUT_MS })
    } catch {
      // The directory stays; nothing else depends on it.
    }
  }

  // The login, the browser, the code, then the enrolment. Returns the toast for the outcome.
  async function attempt(job) {
    const { host, settings, account, login, workspace } = job
    const ctx = { exec, settings, homedir }
    if (job.cancelled) return cancelledToast(host)

    const made = { ...(await exec([settings.sshBin, ...settings.sshOptions, login.ssh, 'mktemp -d'], { timeoutMs: STEP_TIMEOUT_MS })), host: login.name, remote: true }
    if (!commandOk(made)) return stepFailedToast(host, login, made)
    const dir = lastLine(made.stdout)
    if (!usableDir(dir)) {
      // A directory that mktemp printed but that cannot be used is removed if it is empty; rmdir never removes more.
      if (dir) await removeEmptyDir(ctx, login, dir)
      return toast(host.name, 'sign-in failed', `${login.name} did not give a usable login directory.\nNothing was enrolled.`)
    }
    job.dir = dir
    if (job.cancelled) return cancelledToast(host)

    const args = ['auth', 'login', ...(account ? ['--email', account] : [])]
    const command = remoteLoginCommand({ dir, claudeBin: claudeBinOf(login), args })
    const handle = startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs })
    job.handle = handle
    handle.exit.then((exit) => { job.loginExit = exit })
    const reached = await handle.url
    const stopped = async () => {
      handle.stop()
      await handle.exit
    }
    if (job.cancelled) {
      await stopped()
      return cancelledToast(host)
    }
    if (!reached.url) {
      await stopped()
      // The overall limit can fire before the address appears; that is a timed-out sign-in, whatever the stream said.
      if (handle.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
      if (reached.reason === 'timeout') {
        return toast(host.name, 'sign-in failed', `Claude did not print its sign-in address within ${urlTimeoutMs / 1000} s.\nNothing was enrolled.`)
      }
      return loginFailedToast(host, login, await handle.exit)
    }

    // The sign-in address must be one of Claude's own sites, over https, before anything is opened for it.
    if (!isSignInUrl(reached.url)) {
      await stopped()
      return toast(host.name, 'sign-in failed', `Claude's sign-in address is not on claude.ai, claude.com or anthropic.com, so nothing was opened.\nNothing was enrolled.`)
    }

    // The browser is Orca's, in the local workspace, in the account's own isolated profile.
    const profile = await profileFor(ctx, account, now, suffix)
    if (profile.fresh && profile.created) job.freshProfile = profile.created
    if (job.cancelled) {
      await stopped()
      return cancelledToast(host)
    }
    if (!profile.ok) {
      await stopped()
      return orcaFailedToast(host, workspace.label, profile.message)
    }
    const tab = await orcaCall(ctx, ['tab', 'create', '--worktree', workspace.selector, '--url', reached.url, '--profile', profile.id])
    if (tab.ok && typeof tab.result?.browserPageId === 'string') job.pageId = tab.result.browserPageId
    if (job.pageId !== null) await focusTab(ctx, job.pageId, workspace.selector, log)
    if (job.pageId === null) {
      // A tab that failed or timed out may still have opened: close any on this address, then stop the login.
      await closeTabsAt(ctx, reached.url)
      await stopped()
      return orcaFailedToast(host, workspace.label, tab.ok ? 'Orca did not return a tab' : tab.message)
    }

    // The user approves in the tab; the callback's code is relayed to the login, so nothing is copied by hand. Only a
    // callback carrying the state of the address this job opened is relayed.
    const expectedState = new URL(reached.url).searchParams.get('state')
    // The sign-in pages are stepped in this tab: the e-mail (re-authentication only), Continue, the code box and the
    // consent. The code box itself is never typed into, and the identity is proved by the user alone.
    const automate = createStepper({
      call: (args) => orcaCall(ctx, args),
      log,
      notify: publish,
      host,
      page: job.pageId,
      workspace: workspace.selector,
      account,
      authorizeUrl: reached.url,
      isSignInPage: (url) => !offTheFlow(url) && isSignInUrl(url) && new URL(url).hostname !== CALLBACK_HOST,
    })
    const relayed = await relayCode({ ctx, page: job.pageId, workspace: workspace.selector, authorizeUrl: reached.url, handle, timers, now, expectedState, cancelled: () => job.cancelled, log, automate })
    if (relayed === 'idle' || relayed === 'closed') {
      await stopped()
      if (job.cancelled) return cancelledToast(host)
      if (relayed === 'closed') return toast(host.name, 'sign-in failed', 'The sign-in tab was closed.\nNothing was enrolled.')
      return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    }
    const exit = await handle.exit
    if (job.cancelled) return cancelledToast(host)
    if (exit.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    if (exit.spawnError || exit.code !== 0) return loginFailedToast(host, login, exit)

    job.enrolling = true
    return enrol(job, dir)
  }

  // The card's host enrols the login. On the login host itself the directory is read there (enrol --from). On any other
  // host the export is read on the login host and piped to that host's engine as its stdin, never in an argument.
  async function enrol({ host, settings, account, login }, dir) {
    const runner = createRunner({ settings, exec, homedir })
    const expect = account ? ['--expect-email', account] : []
    if (host.name === login.name) {
      let name = account
      if (name === null) {
        name = emailIn(await runner.run(login, ['login-export', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS }))
        if (name === null) return notFinishedToast(host, login)
      }
      return enrolToast(host, await runner.run(login, ['enrol', '--from', dir, '--name', name, ...expect, '--json'], { timeoutMs: STEP_TIMEOUT_MS }))
    }
    const exported = await runner.run(login, ['login-export', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS })
    const email = emailIn(exported)
    if (email === null) return notFinishedToast(host, login)
    return enrolToast(host, await runner.run(host, ['enrol', '--stdin', '--name', account ?? email, ...expect, '--json'], { timeoutMs: STEP_TIMEOUT_MS, input: exported.stdout }))
  }

  // Stops a job's login if it is still running, discards the login on the login host and closes the browser tab.
  // Every path runs it. It never throws.
  async function cleanup(job) {
    const ctx = { exec, settings: job.settings, homedir }
    // The login is stopped and has ended before its directory is discarded. A login that did not exit 0 is also ended
    // on the login host by its pid, since a dropped ssh connection does not hang up the remote process.
    if (job.handle) {
      job.handle.stop()
      await job.handle.exit
      if (job.handle.pid !== null && job.loginExit?.code !== 0) await stopRemoteLogin({ exec, settings: job.settings, log }, job.login, job.handle.pid)
      else if (job.handle.pid === null && job.loginExit?.code !== 0) log('grazr sign-in: remote login pid unknown; it ends by itself within 30 minutes')
    }
    if (job.dir !== null) {
      try {
        const discarded = await createRunner(ctx).run(job.login, ['login-discard', '--from', job.dir], { timeoutMs: STEP_TIMEOUT_MS })
        if (!commandOk(discarded)) log(`grazr sign-in: the login on ${job.login.name} was not discarded`)
      } catch (err) {
        log(`grazr sign-in: discard failed: ${describe(err)}`)
      }
    }
    if (job.pageId !== null) {
      try {
        const closed = await orcaCall(ctx, ['tab', 'close', '--page', job.pageId])
        if (!closed.ok) log(`grazr sign-in: the browser tab did not close: ${closed.message}`)
      } catch (err) {
        log(`grazr sign-in: tab close failed: ${describe(err)}`)
      }
    }
    // The fresh profile goes once its tab is closed, since Orca will not delete a profile a tab still uses.
    if (job.freshProfile !== null) {
      try {
        // Without an id (the list after the create failed), the profile is found again by its label.
        const id = job.freshProfile.id ?? (await profileIdByLabel(ctx, job.freshProfile.label))
        if (id === null) {
          log('grazr sign-in: the fresh browser profile could not be found to delete')
        } else {
          const deleted = await orcaCall(ctx, ['tab', 'profile', 'delete', '--profile', id])
          if (!deleted.ok) log(`grazr sign-in: the fresh browser profile was not deleted: ${deleted.message}`)
        }
      } catch (err) {
        log(`grazr sign-in: profile delete failed: ${describe(err)}`)
      }
    }
  }

  return { start, running }
}
