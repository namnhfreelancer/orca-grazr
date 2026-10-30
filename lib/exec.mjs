import { spawn as nodeSpawn } from 'node:child_process'

// SIGTERM first so the engine can release its lock; SIGKILL only if it ignores that.
export const KILL_GRACE_MS = 2000

// Never rejects: callers branch on the result, so a missing binary is data, not an exception.
export function execCapture(argv, { env = process.env, timeoutMs = 10000, cwd, input } = {}, spawnImpl = nodeSpawn) {
  return new Promise((resolve) => {
    const [file, ...args] = argv
    const stdout = []
    const stderr = []
    let timedOut = false
    let timeoutTimer = null
    let killTimer = null

    const finish = (outcome) => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      resolve({ argv, timeoutMs, timedOut, ...outcome })
    }

    let child
    try {
      child = spawnImpl(file, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (spawnError) {
      return finish({ code: null, signal: null, stdout: '', stderr: '', spawnError })
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    // The child may exit before reading its input; that EPIPE is reported through close, not thrown here.
    child.stdin.on('error', () => {})
    child.stdin.end(input)

    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)

    child.on('error', (spawnError) => {
      finish({ code: null, signal: null, stdout: '', stderr: '', spawnError })
    })
    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        spawnError: null,
      })
    })
  })
}
