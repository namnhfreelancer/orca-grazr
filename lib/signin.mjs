import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { createRunner, ok as commandOk } from './runner.mjs'
import { claudeBinOf, environmentOf, isRemote } from './hosts.mjs'
import { expandTilde } from './paths.mjs'
import { toast, failureBody } from './toast.mjs'
import { describe, describeFailure } from './errors.mjs'
import { join, quote, quoteTilde } from './shell-quote.mjs'

// Claude must print its sign-in address within this long, or the job gives up.
export const URL_TIMEOUT_MS = 30 * 1000
// A sign-in not finished within this long is abandoned: the login is stopped and discarded.
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
// SIGTERM first so claude can clean up; SIGKILL only if it ignores that.
export const KILL_GRACE_MS = 2000
// After SIGKILL, a child (or a grandchild that holds its pipes open) may still never emit close; the job then gives up.
export const HARD_DEADLINE_MS = 5000
// Any line of child output that reaches a toast or a message is cut to this many characters.
export const LINE_MAX = 200
const STEP_TIMEOUT_MS = 20000
const ORCA_TIMEOUT_MS = 15000
// The remote login is also wrapped in timeout(1) at this many seconds, so it ends on the remote host too.
export const REMOTE_LOGIN_TIMEOUT_S = 630
// A sign-in address printed without its newline is taken once the output has been quiet this long.
const URL_QUIET_MS = 500
const NO_LOGIN_HOST = 'Sign-in needs a remote Orca environment for the built-in browser'
// The sign-in address: a line that starts with `visit:`. Whether it ends in a newline is checked by the caller.
const SIGNIN_URL = /visit:\s*(https:\/\/\S+)(\r?\n)?/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Only these sites may be opened in Orca's browser for a sign-in, and only over https.
const SIGNIN_SITES = ['claude.ai', 'claude.com', 'anthropic.com']

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

// The profile label for an account: one isolated profile per account, reused by every sign-in for it.
export const profileLabel = (account) => (account ? `grazr · ${account}` : 'grazr · new account')

// The host that signs in. A remote card signs in on itself. A Mac card signs in on signinHost when it names a usable
// remote host, else on the first remote host that has an Orca environment. Null when there is none.
export function loginHostFor(settings, host) {
  if (isRemote(host)) return environmentOf(host) ? host : null
  if (typeof settings.signinHost === 'string' && settings.signinHost !== '') {
    const named = settings.hosts.find((h) => h.name === settings.signinHost)
    return named && isRemote(named) && environmentOf(named) ? named : null
  }
  return settings.hosts.find((h) => isRemote(h) && environmentOf(h)) ?? null
}

// One Orca CLI call on this Mac, with --json. Never rejects: a failure is { ok: false, message }.
async function orcaCall({ exec, settings, homedir }, args) {
  const bin = expandTilde(settings.orcaBin, homedir)
  const result = await exec([bin, ...args, '--json'], { timeoutMs: ORCA_TIMEOUT_MS })
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) return { ok: true, result: reply.result }
  const message = typeof reply?.error?.message === 'string' ? reply.error.message : result.spawnError ? `could not run ${bin}` : 'no answer from Orca'
  return { ok: false, message: clip(message) }
}

// yyyy-mm-dd hh:mm in local time, for the label of a fresh profile.
const stamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The profile lists of an environment, as { profiles } or { error }.
async function listProfiles(ctx, env) {
  const listed = await orcaCall(ctx, ['tab', 'profile', 'list', '--environment', env])
  return listed.ok ? { profiles: listed.result?.profiles ?? [] } : { error: listed.message }
}

// The isolated profile for a sign-in. A re-authentication reuses the account's profile, found by its label or created
// once. An add-account sign-in creates a fresh one: its label carries the time and a random suffix, and its id is the
// one listed after the create that was not listed before it. created is set as soon as Orca has made the profile,
// so a job that ends early still deletes it (by id, or by label when the id could not be read).
async function profileFor(ctx, env, account, now, suffix) {
  if (account !== null) {
    const label = profileLabel(account)
    const listed = await listProfiles(ctx, env)
    if (listed.error) return { ok: false, message: listed.error }
    const existing = listed.profiles.find((p) => p?.label === label)
    if (typeof existing?.id === 'string') return { ok: true, id: existing.id, fresh: false }
    const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--environment', env, '--label', label, '--scope', 'isolated'])
    if (!made.ok) return { ok: false, message: made.message }
    const again = await listProfiles(ctx, env)
    if (again.error) return { ok: false, message: again.error }
    const id = again.profiles.find((p) => p?.label === label)?.id
    return typeof id === 'string' ? { ok: true, id, fresh: false } : { ok: false, message: `Orca did not list the profile ${label}` }
  }
  const before = await listProfiles(ctx, env)
  if (before.error) return { ok: false, message: before.error }
  const known = new Set(before.profiles.map((p) => p?.id))
  const label = `${profileLabel(null)} ${stamp(now())} ${suffix()}`
  const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--environment', env, '--label', label, '--scope', 'isolated'])
  if (!made.ok) return { ok: false, message: made.message }
  const created = { label, id: null }
  const after = await listProfiles(ctx, env)
  if (after.error) return { ok: false, message: after.error, fresh: true, created }
  const id = after.profiles.find((p) => p?.label === label && typeof p.id === 'string' && !known.has(p.id))?.id
  if (typeof id !== 'string') return { ok: false, message: `Orca did not list the profile ${label}`, fresh: true, created }
  created.id = id
  return { ok: true, id, fresh: true, created }
}

// The id of the one profile with this label, found again by label; null when there is none or more than one.
async function profileIdByLabel(ctx, env, label) {
  const listed = await listProfiles(ctx, env)
  if (listed.error) return null
  const matches = listed.profiles.filter((p) => p?.label === label && typeof p.id === 'string')
  return matches.length === 1 ? matches[0].id : null
}

// Closes every tab on the environment whose address is the sign-in address. Best effort: it never throws.
async function closeTabsAt(ctx, env, url) {
  const listed = await orcaCall(ctx, ['tab', 'list', '--worktree', 'all', '--environment', env])
  if (!listed.ok) return
  for (const tab of listed.result?.tabs ?? []) {
    const page = tab?.browserPageId ?? tab?.id
    if (tab?.url === url && typeof page === 'string') await orcaCall(ctx, ['tab', 'close', '--environment', env, '--page', page])
  }
}

// Starts claude's login on the login host over ssh. The ssh child gets a pty (-tt), so dropping the connection hangs up
// the remote login; the remote command is also wrapped in timeout(1). stdin is held open (closing it aborts the flow).
// handle.url resolves { url } once claude prints its sign-in address, or { reason } when it never does (the address
// may arrive on stdout or stderr). handle.exit resolves once the ssh child has ended, with the output it printed.
// handle.stop() kills it. Nothing here rejects.
function startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs }) {
  let resolveUrl
  let resolveExit
  const handle = {
    url: new Promise((resolve) => { resolveUrl = resolve }),
    exit: new Promise((resolve) => { resolveExit = resolve }),
    timedOut: false,
    stop: () => {},
  }
  let child
  try {
    child = spawn(settings.sshBin, ['-tt', ...settings.sshOptions, login.ssh, command], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  handle.stop = () => {
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
  // With a pty the remote's stderr arrives on stdout, so the last line of either is the reason.
  const last = [exit.stderr, exit.output].map((t) => (t ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1)).find(Boolean)
  return toast(host.name, 'sign-in failed', `${clip(last ?? `exit ${exit.code ?? exit.signal}`)}\nNothing was enrolled.`)
}

const orcaFailedToast = (host, env, message) => toast(host.name, 'sign-in failed', `Orca's browser on ${clip(env)} could not open the sign-in: ${clip(message)}\nNothing was enrolled.`)

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
}) {
  // The job holding each card's host. A host has at most one: a newer start replaces the older one.
  const active = new Map()
  // The host names with a job that has not yet released its login.
  const running = new Set()

  // Returns at once. The job runs in the background and ends with a toast and a panel refresh.
  function start({ host, settings, account = null }) {
    const login = loginHostFor(settings, host)
    if (!login) return { ok: false, message: NO_LOGIN_HOST }
    if (account !== null && account.startsWith('-')) return { ok: false, message: 'That account name cannot be used for a sign-in' }
    const previous = active.get(host.name) ?? null
    previous?.cancel()
    const job = {
      host, settings, account, login,
      cancelled: false, enrolling: false, dir: null, pageId: null, freshProfile: null, handle: null,
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
    return { ok: true, message: `Sign in to ${account ?? 'a new account'} in Orca's browser (${environmentOf(login)})` }
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

// The login, the browser, then the enrolment. Returns the toast for the outcome.
  async function attempt(job) {
    const { host, settings, account, login } = job
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
    const command = `CLAUDE_CONFIG_DIR=${quote(dir)} timeout ${REMOTE_LOGIN_TIMEOUT_S} ${quoteTilde(claudeBinOf(login))} ${join(args)}`
    const handle = startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs })
    job.handle = handle
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

    // The browser is Orca's, on the login host's environment, in the account's own isolated profile.
    const env = environmentOf(login)
    const profile = await profileFor(ctx, env, account, now, suffix)
    if (profile.fresh && profile.created) job.freshProfile = profile.created
    if (job.cancelled) {
      await stopped()
      return cancelledToast(host)
    }
    if (!profile.ok) {
      await stopped()
      return orcaFailedToast(host, env, profile.message)
    }
    const tab = await orcaCall(ctx, ['tab', 'create', '--environment', env, '--url', reached.url, '--profile', profile.id])
    if (tab.ok && typeof tab.result?.browserPageId === 'string') job.pageId = tab.result.browserPageId
    if (job.pageId === null) {
      // A tab that failed or timed out may still have opened: close any on this address, then stop the login.
      await closeTabsAt(ctx, env, reached.url)
      await stopped()
      return orcaFailedToast(host, env, tab.ok ? 'Orca did not return a tab' : tab.message)
    }

    const exit = await handle.exit
    if (job.cancelled) return cancelledToast(host)
    if (exit.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    if (exit.spawnError || exit.code !== 0) return loginFailedToast(host, login, exit)

    job.enrolling = true
    return enrol(job, dir)
  }

  // A card on a remote host enrols the login where it is. A Mac card gets the export as its engine's stdin, never argv.
  async function enrol({ host, settings, account, login }, dir) {
    const runner = createRunner({ settings, exec, homedir })
    const expect = account ? ['--expect-email', account] : []
    if (isRemote(host)) {
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
    // The login is stopped and has ended before its directory is discarded.
    if (job.handle) {
      job.handle.stop()
      await job.handle.exit
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
        const closed = await orcaCall(ctx, ['tab', 'close', '--environment', environmentOf(job.login), '--page', job.pageId])
        if (!closed.ok) log(`grazr sign-in: the browser tab did not close: ${closed.message}`)
      } catch (err) {
        log(`grazr sign-in: tab close failed: ${describe(err)}`)
      }
    }
    // The fresh profile goes once its tab is closed, since Orca will not delete a profile a tab still uses.
    if (job.freshProfile !== null) {
      try {
        const env = environmentOf(job.login)
        // Without an id (the list after the create failed), the profile is found again by its label.
        const id = job.freshProfile.id ?? (await profileIdByLabel(ctx, env, job.freshProfile.label))
        if (id === null) {
          log('grazr sign-in: the fresh browser profile could not be found to delete')
        } else {
          const deleted = await orcaCall(ctx, ['tab', 'profile', 'delete', '--environment', env, '--profile', id])
          if (!deleted.ok) log(`grazr sign-in: the fresh browser profile was not deleted: ${deleted.message}`)
        }
      } catch (err) {
        log(`grazr sign-in: profile delete failed: ${describe(err)}`)
      }
    }
  }

  return { start, running }
}
