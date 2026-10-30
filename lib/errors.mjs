const ENGINE_PREFIX = 'grazr: '

// A rejection may carry no Error (throw undefined), so the message fallback must cover that.
export const describe = (err) => err?.message ?? String(err)

const lines = (text) => (text ?? '').split('\n')
const firstLine = (text) => lines(text).map((l) => l.trim()).find(Boolean) ?? ''
const lastLine = (text) => lines(text).map((l) => l.trim()).filter(Boolean).pop() ?? ''

function engineLine(result) {
  for (const text of [result.stdout, result.stderr]) {
    const line = lines(text).find((l) => l.startsWith(ENGINE_PREFIX))
    if (line !== undefined) return line.slice(ENGINE_PREFIX.length).trim()
  }
  return null
}

// Ordered by specificity: a timeout hides everything, an engine line beats a bare exit code.
export function describeFailure(result) {
  const { code, signal, stdout, stderr, timedOut, spawnError, remote, timeoutMs } = result
  if (timedOut) {
    const secs = Number.isFinite(timeoutMs) ? ` after ${timeoutMs / 1000}s` : ''
    return { kind: 'timeout', detail: `timed out${secs}` }
  }
  if (spawnError?.code === 'ENOENT' || code === 127) {
    return { kind: 'missing-binary', detail: firstLine(stderr) || spawnError?.message || '' }
  }
  // Other spawn failures (EACCES, EMFILE) have no exit code, so the message is the only detail.
  if (spawnError) return { kind: 'exit', detail: spawnError.message }
  if (remote && code === 255) {
    return { kind: 'unreachable', detail: lastLine(stderr) }
  }
  // Python exits 2 when the engine file is missing, so the host has not had grazr installed yet.
  if (code === 2 && (stderr ?? '').includes("can't open file")) {
    return { kind: 'not-installed', detail: lastLine(stderr) }
  }
  const engine = engineLine(result)
  if (engine !== null) return { kind: 'engine', detail: engine }
  const exitCode = code ?? signal
  return { kind: 'exit', detail: `exit ${exitCode}: ${lastLine(stderr) || lastLine(stdout)}` }
}
