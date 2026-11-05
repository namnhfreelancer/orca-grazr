// Moves the Claude terminal sessions still running on an account that is no longer the selected one, on a host of the
// Orca accounts mode, by restarting each idle one with --resume in its own pane.
//
// Orca restarts sessions itself only on this Mac, and only when its "running sessions" choice says so; on a paired
// environment nothing moves them. Native Orca chats need nothing: Orca replaces a chat's process on its next message
// when the selected account changed, and resumes the conversation.
//
// A restart, all through the host's Orca runtime: Ctrl-C (clears a draft, or arms Claude's exit), `/exit`, wait for
// the pane's shell, then type `claude <Orca's default args> --resume <session>`. Orca's shell integration defines
// `claude` to read the selected account (claude-profiles/selected-host) at each run, so the new process starts on the
// new account. Every account home shares one projects folder, so the transcript is found from either account.
//
// The relaunch line is stored before the exit, so a worker restarted mid-way types it on its next tick.

const PROFILE_HOME = /\/claude-profiles\/([^/]+)\/home\//
const PENDING_KEY = 'orcaPendingRelaunch'
const ATTEMPTS_KEY = 'orcaRestartAttempts'
// A pane restarted once is not tried again for this long, so a restart that did not take never loops.
const RETRY_AFTER_MS = 30 * 60000
// On this Mac, Orca's own restart gets this long after a swap before grazr moves what it left.
export const LOCAL_GRACE_MS = 90000
const EXIT_WAIT_MS = 10000
const POLL_MS = 500
// A pending relaunch older than this is dropped rather than typed into whatever the pane runs now.
const PENDING_MAX_AGE_MS = 10 * 60000
const IDLE = new Set(['idle', 'done'])
// What Claude Code prints when a usage limit ends a turn ("5-hour limit reached ∙ resets 1pm", "You've hit your limit ·
// resets 3pm", "Claude usage limit reached"). Only the last lines of the pane count, so a conversation about limits
// further up does not.
const LIMIT_TEXT = /\blimit (?:reached|will reset|resets?)\b|\bhit your [\w' ]{0,40}limit\b/i
const LIMIT_LINES = 12
// The prompt a limited session is relaunched with, Orca's own words for continuing a turn a usage limit ended.
export const CONTINUE_PROMPT = 'Continue where you left off.'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string' && v !== ''
const SAFE_SESSION_ID = /^[A-Za-z0-9-]{8,128}$/

// The Claude panes Orca reports on a host: terminal handle, state, provider session and the account it runs on.
export function claudePanes(listed) {
  const panes = []
  for (const snapshot of Array.isArray(listed?.snapshots) ? listed.snapshots : []) {
    for (const tab of Array.isArray(snapshot?.tabs) ? snapshot.tabs : []) {
      const status = tab?.agentStatus
      if (!isObject(status) || status.agentType !== 'claude' || !isString(status.terminalHandle)) continue
      const session = isObject(status.providerSession) ? status.providerSession : {}
      const accountId = isString(session.transcriptPath) ? session.transcriptPath.match(PROFILE_HOME)?.[1] ?? null : null
      panes.push({
        handle: status.terminalHandle,
        state: isString(status.state) ? status.state : null,
        sessionId: isString(session.id) && SAFE_SESSION_ID.test(session.id) ? session.id : null,
        accountId,
        title: isString(tab.title) ? tab.title : status.terminalHandle,
      })
    }
  }
  return panes
}

// Whether a pane's last lines say a usage limit ended its turn.
export function showsUsageLimit(preview) {
  if (!isString(preview)) return false
  return preview.split('\n').map((l) => l.trim()).filter(Boolean).slice(-LIMIT_LINES).some((l) => LIMIT_TEXT.test(l))
}

// The line Orca itself would launch Claude with, resuming the session; with a prompt, the turn carries on at once.
export function relaunchLine(launchSettings, sessionId, prompt = null) {
  const command = launchSettings?.agentCmdOverrides?.claude
  const args = launchSettings?.agentDefaultArgs?.claude
  const program = isString(command) ? command.trim() : 'claude'
  const tail = isString(prompt) ? `'${prompt.replaceAll("'", "'\\''")}'` : ''
  return [program, isString(args) ? args.trim() : '', '--resume', sessionId, tail].filter(Boolean).join(' ')
}

export function createSessionMover({ rpc, storage, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  async function readMap(key) {
    try {
      const value = await storage.get(key)
      return isObject(value) ? value : {}
    } catch {
      return {}
    }
  }
  async function updateMap(key, change) {
    const map = await readMap(key)
    change(map)
    await storage.set(key, map)
  }
  const pendingKey = (h, handle) => `${h.name}\u0000${handle}`

  async function agentStatus(h, handle, timeoutMs) {
    const status = await rpc(h, 'terminal.agentStatus', { terminal: handle }, timeoutMs)
    return status.ok && isObject(status.result?.agentStatus) ? status.result.agentStatus : null
  }
  const send = (h, handle, params, timeoutMs) => rpc(h, 'terminal.send', { terminal: handle, ...params }, timeoutMs)

  async function waitForShell(h, handle, timeoutMs) {
    const deadline = now() + EXIT_WAIT_MS
    while (now() < deadline) {
      await sleep(POLL_MS)
      const status = await agentStatus(h, handle, timeoutMs)
      if (status && status.isRunningAgent === false) return true
    }
    return false
  }

  // A relaunch a restarted worker left behind: typed once the pane is back at its shell, dropped if it is not.
  async function finishPending(h, timeoutMs) {
    const pending = await readMap(PENDING_KEY)
    for (const [key, entry] of Object.entries(pending)) {
      if (!key.startsWith(`${h.name}\u0000`) || !isObject(entry)) continue
      const status = await agentStatus(h, entry.handle, timeoutMs)
      if (status && status.isRunningAgent === false && now() - entry.at < PENDING_MAX_AGE_MS) {
        await send(h, entry.handle, { text: entry.line, enter: true }, timeoutMs)
        log(`grazr: ${h.name}: relaunched ${entry.handle} after a worker restart`)
      }
      await updateMap(PENDING_KEY, (map) => { delete map[key] })
    }
  }

  async function restart(h, pane, line, timeoutMs) {
    const key = pendingKey(h, pane.handle)
    await updateMap(ATTEMPTS_KEY, (map) => { map[key] = { sessionId: pane.sessionId, at: now() } })
    await updateMap(PENDING_KEY, (map) => { map[key] = { handle: pane.handle, line, at: now() } })
    await send(h, pane.handle, { interrupt: true }, timeoutMs)
    await sleep(300)
    await send(h, pane.handle, { text: '/exit', enter: true }, timeoutMs)
    const atShell = await waitForShell(h, pane.handle, timeoutMs)
    // A pane that has not reached its shell yet keeps its pending line, so a later tick relaunches it if it does.
    if (!atShell) return false
    await send(h, pane.handle, { text: line, enter: true }, timeoutMs)
    await updateMap(PENDING_KEY, (map) => { delete map[key] })
    return true
  }

  // The host's Claude panes, each marked limited when its last lines show a usage limit and Orca's reading of its
  // account does not contradict that (an unread account, or one with a window all but spent). null when unlisted.
  async function inspect(h, value, timeoutMs) {
    const listed = await rpc(h, 'session.tabs.listAll', {}, timeoutMs)
    if (!listed.ok) {
      log(`grazr: ${h.name}: could not list sessions: ${listed.failure.detail}`)
      return null
    }
    const panes = claudePanes(listed.result)
    if (panes.length === 0) return panes
    const terminals = await rpc(h, 'terminal.list', {}, timeoutMs)
    const previews = new Map((terminals.ok && Array.isArray(terminals.result?.terminals) ? terminals.result.terminals : [])
      .filter((t) => isObject(t) && isString(t.handle))
      .map((t) => [t.handle, t.preview]))
    const spentOrUnread = (accountId) => {
      const snapshot = value.accounts.find((a) => a.id === accountId)?.snapshot
      return !Array.isArray(snapshot) || snapshot.some((e) => typeof e?.remaining === 'number' && e.remaining <= 5)
    }
    return panes.map((p) => ({ ...p, limited: IDLE.has(p.state) && showsUsageLimit(previews.get(p.handle)) && spentOrUnread(p.accountId) }))
  }

  // value: the host's status report after any swap; panes: what inspect returned this tick. Returns notice lines.
  async function move(h, value, { activeId, lastRotationAt = null, panes, timeoutMs = 20000 } = {}) {
    await finishPending(h, timeoutMs)
    if (!isString(activeId)) return []
    const listed = panes === undefined ? await inspect(h, value, timeoutMs) : panes
    if (!listed) return []
    // On this Mac Orca's own restart goes first, but it does not continue a turn a limit ended, so a limited pane does not wait.
    const inGrace = !h.orcaEnvironment && lastRotationAt !== null && now() - lastRotationAt < LOCAL_GRACE_MS
    const known = new Set(value.accounts.map((a) => a.id))
    const attempts = await readMap(ATTEMPTS_KEY)
    const stale = listed.filter((p) => p.sessionId && p.accountId && known.has(p.accountId) && p.accountId !== activeId && (!inGrace || p.limited))
    const due = stale.filter((p) => {
      const last = attempts[pendingKey(h, p.handle)]
      return !(last && last.sessionId === p.sessionId && now() - last.at < RETRY_AFTER_MS)
    })
    if (due.length === 0) return []
    const launch = await rpc(h, 'settings.getAgentLaunch', {}, timeoutMs)
    const launchSettings = launch.ok ? launch.result?.settings : null
    const nameOf = (id) => value.accounts.find((a) => a.id === id)?.name ?? id
    const moved = []
    const failed = []
    for (const pane of due) {
      // Only a pane that is idle now is restarted; a busy one waits for a later tick.
      if (!IDLE.has(pane.state)) continue
      const live = await agentStatus(h, pane.handle, timeoutMs)
      if (!live || live.isRunningAgent !== true || !IDLE.has(live.status)) continue
      const ok = await restart(h, pane, relaunchLine(launchSettings, pane.sessionId, pane.limited ? CONTINUE_PROMPT : null), timeoutMs)
      ;(ok ? moved : failed).push(pane)
      log(`grazr: ${h.name}: ${ok ? 'restarted' : 'could not restart'} ${pane.title}${pane.limited ? ' (usage limit, continued)' : ''} (${nameOf(pane.accountId)} → ${nameOf(activeId)})`)
    }
    const lines = []
    if (moved.length > 0) {
      lines.push(JSON.stringify({ title: 'grazr: sessions moved', body: `${moved.length} Claude session${moved.length === 1 ? '' : 's'} resumed on ${nameOf(activeId)}` }))
    }
    if (failed.length > 0) {
      lines.push(JSON.stringify({ title: 'grazr: session not moved', body: `${failed.map((p) => p.title).join(', ')} did not exit; restart it by hand` }))
    }
    return lines
  }

  return { inspect, move }
}
