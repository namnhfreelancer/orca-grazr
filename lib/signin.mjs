import os from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { createRunner, ok as commandOk } from './runner.mjs'
import { isRemote } from './hosts.mjs'
import { toast, failureBody } from './toast.mjs'
import { describe, describeFailure } from './errors.mjs'

// A browser login left unfinished is abandoned after this long; the job then kills claude and discards the login.
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
// SIGTERM first so claude can clean up; SIGKILL only if it ignores that.
export const KILL_GRACE_MS = 2000
// After SIGKILL, a child (or a grandchild that holds its pipes open) may still never emit close; the job then gives up.
export const HARD_DEADLINE_MS = 5000
// Any line of a child's output that reaches a toast or a message is cut to this many characters.
export const LINE_MAX = 200
const STEP_TIMEOUT_MS = 20000
const LOGIN_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SHELL']

// Only an allowlist of the worker's variables reaches claude; its config dir is the throwaway one.
export function loginEnv(base, configDir) {
  const env = {}
  for (const key of LOGIN_ENV_KEYS) if (base[key] !== undefined) env[key] = base[key]
  env.CLAUDE_CONFIG_DIR = configDir
  return env
}

// Child output is clipped before it is shown: one line, at most LINE_MAX characters, ending in an ellipsis when cut.
export function clip(text) {
  const s = String(text ?? '')
  return s.length <= LINE_MAX ? s : `${s.slice(0, LINE_MAX - 1)}…`
}

// The engine prints one JSON line on stdout; anything else (a failure that printed no JSON) gives null.
function parseReply(stdout) {
  const line = (stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// Runs `claude auth login` with stdin left open (closing it can abort the flow). Resolves once it exits,
// or once the timeout has killed it. It never rejects.
function loginWithClaude({ spawn, timers, baseEnv, settings, dir, account, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['auth', 'login', ...(account ? ['--email', account] : [])]
    let child
    try {
      child = spawn(settings.claudeBin, args, { env: loginEnv(baseEnv, dir), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (spawnError) {
      return resolve({ timedOut: false, spawnError, code: null, signal: null, stderr: '' })
    }
    const err = []
    let timedOut = false
    let settled = false
    let limit = null
    let grace = null
    let hard = null
    const finish = (outcome) => {
      if (settled) return
      settled = true
      timers.clearTimeout(limit)
      timers.clearTimeout(grace)
      timers.clearTimeout(hard)
      // Once the child has ended or been killed, closing its stdin is what lets the pipes go.
      child.stdin?.destroy?.()
      resolve({ timedOut, stderr: Buffer.concat(err).toString('utf8'), spawnError: null, code: null, signal: null, ...outcome })
    }
    // stdout is drained so a chatty claude never blocks; its text is not needed.
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => err.push(chunk))
    // claude may exit before reading stdin; that EPIPE is reported through close, not thrown.
    child.stdin?.on('error', () => {})
    child.on('error', (spawnError) => finish({ spawnError }))
    child.on('close', (code, signal) => finish({ code, signal }))
    limit = timers.setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      grace = timers.setTimeout(() => {
        child.kill('SIGKILL')
        // close can still never come (a grandchild holding the pipes): the job stops waiting and is released.
        hard = timers.setTimeout(() => finish({ timedOut: true, code: null, signal: 'SIGKILL' }), HARD_DEADLINE_MS)
      }, KILL_GRACE_MS)
    }, timeoutMs)
  })
}

// The job's outcome text: enrolled, refused, or the engine's failure. Never includes the export itself.
function enrolToast(host, result) {
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) {
    const note = reply.unblocked === false ? '\nIt is still blocked; press Refresh on the card.' : ''
    return toast(host.name, 'signed in', `Enrolled ${clip(reply.email ?? 'the account')} on ${host.name}${note}`)
  }
  if (typeof reply?.error === 'string' && reply.error !== '') {
    return toast(host.name, 'sign-in failed', `${clip(reply.error)}\nNothing was enrolled.`)
  }
  const failure = describeFailure(result)
  if (failure.kind === 'unreachable') {
    return toast(host.name, 'sign-in failed', `${host.name} could not be reached; nothing was enrolled there.`)
  }
  return toast(host.name, 'sign-in failed', `${clip(failureBody(failure))}\nNothing was enrolled.`)
}

export function createSigninJobs({
  exec = execCapture,
  spawn = nodeSpawn,
  homedir = os.homedir,
  tmpdir = os.tmpdir(),
  fs = nodeFs,
  baseEnv = process.env,
  timers = { setTimeout, clearTimeout },
  log = () => {},
  publish,
  refreshPanel,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
}) {
  // One sign-in per host at a time: a host is held from start until its outcome is out.
  const running = new Set()

  // Returns at once. The job runs in the background and ends with a toast and a panel refresh.
  function start({ host, settings, account = null }) {
    if (running.has(host.name)) return { ok: false, message: `A sign-in for ${host.name} is already running` }
    running.add(host.name)
    void run({ host, settings, account })
    return { ok: true, message: `Sign in to ${account ?? 'a new account'} in your browser` }
  }

  async function run(job) {
    let dir = null
    let outcome
    try {
      dir = await fs.mkdtemp(join(tmpdir, 'grazr-login-'))
      outcome = await attempt(job, dir)
    } catch (err) {
      log(`grazr sign-in: ${describe(err)}`)
      outcome = toast(job.host.name, 'sign-in failed', 'The sign-in stopped before it finished.')
    } finally {
      if (dir) await discard(job, dir)
      running.delete(job.host.name)
    }
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

  // Runs the login, then enrols it on the card's host. Returns the toast for the outcome.
  async function attempt({ host, settings, account }, dir) {
    const login = await loginWithClaude({ spawn, timers, baseEnv, settings, dir, account, timeoutMs: loginTimeoutMs })
    if (login.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    if (login.spawnError) return toast(host.name, 'sign-in failed', `Could not run ${clip(settings.claudeBin)}: ${clip(login.spawnError.message)}`)
    if (login.code !== 0) {
      const last = login.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
      return toast(host.name, 'sign-in failed', `${clip(last ?? `exit ${login.code ?? login.signal}`)}\nNothing was enrolled.`)
    }

    const mac = settings.hosts.find((h) => !isRemote(h))
    if (!mac) return toast(host.name, 'sign-in failed', 'No Mac host is configured to sign in on.')
    const macRunner = createRunner({ settings, exec, homedir })
    const exported = await macRunner.run(mac, ['login-export', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS })
    const identity = parseReply(exported.stdout)?.identity
    if (!commandOk(exported) || !identity || !identity.emailAddress) {
      return toast(host.name, 'sign-in failed', 'The login did not finish on this Mac.\nNothing was enrolled.')
    }
    const name = account ?? identity.emailAddress
    const expect = account ? ['--expect-email', account] : []
    const enrol = ['--name', name, ...expect, '--json']

    if (!isRemote(host)) {
      return enrolToast(host, await macRunner.run(mac, ['enrol', '--from', dir, ...enrol], { timeoutMs: STEP_TIMEOUT_MS }))
    }
    // The export goes over ssh stdin, never argv: it carries the credential.
    const remoteRunner = createRunner({ settings, exec, homedir })
    return enrolToast(host, await remoteRunner.run(host, ['enrol', '--stdin', ...enrol], { timeoutMs: STEP_TIMEOUT_MS, input: exported.stdout }))
  }

  // The throwaway login is always discarded, and its directory removed, whatever the outcome. Never throws.
  async function discard(job, dir) {
    try {
      const mac = job.settings.hosts.find((h) => !isRemote(h))
      if (mac) await createRunner({ settings: job.settings, exec, homedir }).run(mac, ['login-discard', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS })
    } catch (err) {
      log(`grazr sign-in: discard failed: ${describe(err)}`)
    }
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (err) {
      log(`grazr sign-in: could not remove ${dir}: ${describe(err)}`)
    }
  }

  return { start, running }
}
