import { ok as commandOk } from './runner.mjs'
import { environmentOf, isRemote } from './hosts.mjs'
import { expandTilde } from './paths.mjs'
import { orcaCall } from './signin.mjs'

// The Orca environment list is read at most this often; the focused workspace is read on every poll.
export const ENVIRONMENT_CACHE_MS = 60000
const SQLITE_TIMEOUT_MS = 5000
const QUERY = "select payload from profile_state_documents where domain='workspaceSession'"
const RUNTIME_PREFIX = 'runtime:'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The plugin host the focused workspace belongs to, read from Orca's own UI session. Never throws: a failure is
// { ok: false, host: null } and is logged once until a read succeeds again.
// A workspace on a paired environment names it as `runtime:<environment id>`, matched to the host of that environment (an
// ssh host or an Orca accounts host); any other host id is this Mac, whose host has no ssh alias and no environment. Environment names come from `orca environment list`, cached for ENVIRONMENT_CACHE_MS.
export function createFocus({ exec, homedir, now = Date.now, log = () => {} }) {
  let environments = null
  let failing = false
  const note = (message) => {
    if (failing) return
    failing = true
    log(`grazr focus: ${message}`)
  }

  // Map from environment id to name, or { error } when the list cannot be read.
  async function environmentNames(settings) {
    if (environments && now() - environments.at < ENVIRONMENT_CACHE_MS) return environments.names
    const listed = await orcaCall({ exec, settings, homedir }, ['environment', 'list'])
    if (!listed.ok) return { error: listed.message }
    const list = Array.isArray(listed.result?.environments) ? listed.result.environments : []
    const names = new Map(list
      .filter((e) => isObject(e) && typeof e.id === 'string' && typeof e.name === 'string')
      .map((e) => [e.id, e.name]))
    environments = { at: now(), names }
    return names
  }

  // The session row's payload, parsed; { error } when sqlite3 fails or the payload is not JSON.
  async function sessionPayload(settings) {
    const db = expandTilde(settings.orcaProfileDb, homedir)
    const result = await exec([settings.sqliteBin, '-readonly', db, QUERY], { timeoutMs: SQLITE_TIMEOUT_MS })
    if (!commandOk(result)) return { error: result.spawnError ? `could not run ${settings.sqliteBin}` : `sqlite3 failed: ${(result.stderr ?? '').trim().slice(0, 160) || 'no output'}` }
    try {
      const parsed = JSON.parse((result.stdout ?? '').trim())
      return isObject(parsed) ? { payload: parsed } : { error: 'the session payload is not an object' }
    } catch {
      return { error: 'the session payload is not JSON' }
    }
  }

  // { ok, host }: the configured host's name, or null when none fits. Never rejects.
  async function current(settings) {
    try {
      const session = await sessionPayload(settings)
      if (session.error) {
        note(session.error)
        return { ok: false, host: null }
      }
      const id = session.payload.activeWorkspaceExecutionHostId
      let host
      if (typeof id === 'string' && id.startsWith(RUNTIME_PREFIX)) {
        const names = await environmentNames(settings)
        if (names.error) {
          note(`orca environment list failed: ${names.error}`)
          return { ok: false, host: null }
        }
        const environment = names.get(id.slice(RUNTIME_PREFIX.length))
        host = environment === undefined ? null : settings.hosts.find((h) => environmentOf(h) === environment)
      } else {
        host = settings.hosts.find((h) => !isRemote(h) && environmentOf(h) === null)
      }
      failing = false
      return { ok: true, host: host?.name ?? null }
    } catch (err) {
      note(`read failed: ${err?.message ?? err}`)
      return { ok: false, host: null }
    }
  }

  return { current }
}
