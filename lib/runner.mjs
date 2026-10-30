import os from 'node:os'
import { execCapture } from './exec.mjs'
import { expandTilde } from './paths.mjs'
import { engineEnv, enginePath, isRemote } from './hosts.mjs'
import { join, quoteTilde } from './shell-quote.mjs'
import { describeFailure } from './errors.mjs'

export function ok(result) {
  return !result.timedOut && !result.spawnError && result.code === 0
}

export function createRunner({ settings, exec = execCapture, homedir = os.homedir }) {
  // Local spawns get no shell, so ~ is expanded here; remote shells expand it themselves.
  function command(host, args) {
    const env = engineEnv(settings, host)
    if (!isRemote(host)) {
      const expanded = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandTilde(v, homedir)]))
      return {
        argv: [expandTilde(host.python, homedir), expandTilde(enginePath(settings), homedir), ...args],
        env: { ...process.env, ...expanded },
      }
    }
    // Prefix assignments, not `env`: a POSIX shell tilde-expands an assignment value, `env` args are not expanded.
    const assignments = Object.entries(env).map(([k, v]) => `${k}=${quoteTilde(v)}`).join(' ')
    const remote = `${assignments} ${quoteTilde(host.python)} ${quoteTilde(enginePath(settings))} ${join(args)}`
    return {
      argv: [settings.sshBin, ...settings.sshOptions, host.ssh, remote],
      env: process.env,
    }
  }

  async function run(host, args, { timeoutMs = 10000, input } = {}) {
    const { argv, env } = command(host, args)
    const result = await exec(argv, { env, timeoutMs, input })
    return { ...result, host: host.name, remote: isRemote(host) }
  }

  async function runJson(host, args, opts) {
    const result = await run(host, args, opts)
    if (!ok(result)) return { ok: false, failure: describeFailure(result), result }
    try {
      return { ok: true, value: JSON.parse(result.stdout) }
    } catch {
      return { ok: false, failure: { kind: 'engine', detail: 'unreadable JSON from engine' }, result }
    }
  }

  async function runLines(host, args, opts) {
    const result = await run(host, args, opts)
    const lines = result.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean)
    if (!ok(result)) return { ok: false, lines, failure: describeFailure(result), result }
    return { ok: true, lines, result }
  }

  return { run, runJson, runLines, command }
}
