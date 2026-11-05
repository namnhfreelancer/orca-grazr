// Native Orca chats a usage limit stopped: found and continued on the host they run on.
//
// A paired client's runtime calls are refused for native chats, so the chat helper (orca-chat-helper.cjs) runs on
// the chat's own host and uses its local socket: on this Mac under Orca's Electron in Node mode, on a paired
// environment over ssh (orcaAccounts.ssh names the alias) under the Node Orca installed there.
//
// A continued chat runs its turn on the account selected now: Orca replaces a chat's process when the selected
// account changed, and resumes the conversation.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ok } from './runner.mjs'
import { quote } from './shell-quote.mjs'
import { orcaBinaries } from './orca-accounts.mjs'

const HELPER_PATH = fileURLToPath(new URL('./orca-chat-helper.cjs', import.meta.url))
// Chats the journal touched within this window are scanned; an older cut is left to the person.
export const SCAN_WINDOW_MS = 6 * 3600000
const CONTINUED_KEY = 'orcaContinuedChats'
const MAX_ATTEMPTS = 3
// A chat continued this often within PER_CHAT_WINDOW_MS is left alone: each continue that reaches a process still on
// the spent account stops at the limit again and leaves a new stopped turn, which would be continued in turn.
const PER_CHAT_CONTINUES = 3
const PER_CHAT_WINDOW_MS = 30 * 60000

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The remote command: Orca's own Node on that server, as its `orca` launcher names it, reading the helper from stdin.
const REMOTE_NODE = `B=$(grep -m1 '^exec ' "$HOME/.config/orca/cli/bin/orca") && N=\${B#exec \\'} && N=\${N%%\\'*} && exec "$N" -`

export function createChatContinuer({ settings, exec, storage, now = Date.now, log = () => {}, readHelper = () => readFileSync(HELPER_PATH, 'utf8') }) {
  async function helper(h, args, timeoutMs) {
    let argv
    let input
    const env = { ...process.env }
    if (!h.orcaEnvironment) {
      argv = [orcaBinaries(settings).electron, HELPER_PATH, ...args]
      env.ELECTRON_RUN_AS_NODE = '1'
      delete env.ORCA_ENVIRONMENT
    } else {
      const alias = settings.orcaAccounts.ssh[h.name]
      if (!alias) return { ok: false, unavailable: true }
      argv = [settings.sshBin, ...settings.sshOptions, alias, `${REMOTE_NODE} ${args.map(quote).join(' ')}`]
      input = readHelper()
    }
    const result = await exec(argv, { env, timeoutMs, ...(input !== undefined ? { input } : {}) })
    let reply = null
    try {
      reply = JSON.parse((result.stdout ?? '').trim().split('\n').at(-1) ?? '')
    } catch {
      reply = null
    }
    if (ok(result) && reply?.ok === true) return { ok: true, result: reply.result }
    const detail = reply?.error?.message ?? ((result.stderr ?? '').trim().split('\n').at(-1) || (result.timedOut ? 'timed out' : `exit ${result.code}`))
    return { ok: false, detail }
  }

  // { available, cuts }: the host's chats a usage limit stopped, each with the account it ran on.
  async function scan(h, timeoutMs) {
    const scanned = await helper(h, ['scan', String(Math.trunc(now() - SCAN_WINDOW_MS))], timeoutMs)
    if (!scanned.ok) {
      if (!scanned.unavailable) log(`grazr: ${h.name}: chat scan failed: ${scanned.detail}`)
      return { available: false, cuts: [] }
    }
    const cuts = Array.isArray(scanned.result?.cuts) ? scanned.result.cuts.filter((c) => isObject(c) && typeof c.sessionId === 'string') : []
    return { available: true, cuts }
  }

  async function readMap() {
    try {
      const value = await storage.get(CONTINUED_KEY)
      return isObject(value) ? value : {}
    } catch {
      return {}
    }
  }

  // Continues each cut once; a refused send is retried on later ticks up to MAX_ATTEMPTS. Returns notice lines.
  async function continueCuts(h, cuts, accountName, timeoutMs) {
    if (cuts.length === 0) return []
    const done = await readMap()
    const continued = []
    for (const cut of cuts) {
      const key = `${h.name}\u0000${cut.sessionId}\u0000${cut.turnItemId}`
      const seen = done[key]
      if (seen?.ok || (seen?.attempts ?? 0) >= MAX_ATTEMPTS) continue
      const recent = Object.entries(done).filter(([k, e]) => e?.ok && k.startsWith(`${h.name}\u0000${cut.sessionId}\u0000`) && now() - e.at < PER_CHAT_WINDOW_MS)
      if (recent.length >= PER_CHAT_CONTINUES) {
        log(`grazr: ${h.name}: chat ${cut.sessionId} was continued ${recent.length} times in 30 minutes and still stops at the limit; leaving it`)
        continue
      }
      // Stopping a chat's background tasks and waiting for them takes up to 20 s on top of the send.
      const sent = await helper(h, ['continue', cut.sessionId, cut.turnItemId], Math.max(timeoutMs, 60000))
      done[key] = sent.ok ? { ok: true, at: now() } : { ok: false, attempts: (seen?.attempts ?? 0) + 1, at: now() }
      if (sent.ok) continued.push(cut)
      const stopped = sent.ok && sent.result?.stoppedTasks > 0 ? ` after stopping ${sent.result.stoppedTasks} background task(s)` : ''
      log(`grazr: ${h.name}: ${sent.ok ? 'continued' : 'could not continue'} chat ${cut.sessionId}${stopped}${sent.ok ? '' : `: ${sent.detail}`}`)
    }
    // Entries older than a day are dropped so the map stays small.
    for (const [key, entry] of Object.entries(done)) if (now() - (entry?.at ?? 0) > 86400000) delete done[key]
    await storage.set(CONTINUED_KEY, done)
    if (continued.length === 0) return []
    return [JSON.stringify({ title: 'grazr: chats continued', body: `${continued.length} chat${continued.length === 1 ? '' : 's'} a usage limit stopped continue on ${accountName}` })]
  }

  return { scan, continueCuts }
}
