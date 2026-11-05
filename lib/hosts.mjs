export const DEFAULT_SETTINGS = {
  // orca-accounts: rotate the Claude account Orca launches with (Settings › AI Provider Accounts), on this Mac and every
  // paired environment; nothing is installed anywhere. engine: the grazr engine rotates the System default ~/.claude
  // login on the hosts below, over ssh.
  mode: 'orca-accounts',
  // The Orca app whose CLI client makes the accounts calls, in the orca-accounts mode.
  orcaApp: '/Applications/Orca.app',
  orcaAccounts: {
    // Swap away when the active account has less than this many percent left in its 5-hour or weekly window.
    thresholds: { session: 15, weekly: 10 },
    // The paired Orca environments to rotate on: 'all', 'none', or a list of environment names.
    environments: 'all',
    // The name this Mac's card and toasts use.
    localName: 'mac',
  },
  // Only the local Mac by default. Add ssh hosts (see the README) under settings.json's hosts.
  hosts: [
    { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' }
  ],
  target: 'mac',
  engineDir: '~/.local/share/orca-grazr/engine',
  stateDir:  '~/.local/state/orca-grazr',
  configDir: '~/.config/orca-grazr',
  drainIntervalMs: 120000,
  drainEnabled: true,
  maxToastsPerHostPerCycle: 5,
  forceInstall: false,
  // The face and window every card opens with; the panel's toggles switch them for the life of the page.
  panelFace: 'clock',
  panelView: 'session',
  sshBin: '/usr/bin/ssh',
  rsyncBin: '/usr/bin/rsync',
  // The Orca CLI that opens the built-in browser for a sign-in. A blank or dash-prefixed path falls back to the default.
  orcaBin: '/usr/local/bin/orca',
  // The Orca profile database the focused workspace's host is read from, read-only, and the sqlite3 that reads it.
  orcaProfileDb: '~/Library/Application Support/orca/profiles/local-default/profile-state.db',
  sqliteBin: '/usr/bin/sqlite3',
  sshOptions: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5']
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Arrays and scalars replace; only plain objects merge key by key.
function deepMerge(base, over) {
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

// forceInstall null means the host follows the global setting.
const HOST_DEFAULTS = { ssh: null, python: 'python3', notifier: 'queue', forceInstall: null }

// The Claude Code binary a host runs for a sign-in over ssh, when the host sets none.
export const DEFAULT_CLAUDE_BIN = '~/.local/bin/claude'

// A binary path is usable when it is not blank and does not start with '-', which would read as one of its options.
const isBinary = (v) => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('-')

// A host without a name cannot be targeted, so it is dropped rather than repaired.
// A host's optional claudeBin is checked when it is set; an unusable one falls back to the default.
function normaliseHost(host) {
  if (!(isPlainObject(host) && typeof host.name === 'string')) return null
  // An ssh alias that starts with '-' would be read as an ssh option, so the host is dropped rather than run.
  if (typeof host.ssh === 'string' && host.ssh.trim().startsWith('-')) return null
  const out = { ...HOST_DEFAULTS, ...host }
  if (typeof out.orcaEnvironment === 'string' && out.orcaEnvironment.trim().startsWith('-')) out.orcaEnvironment = null
  if ('claudeBin' in host && !isBinary(host.claudeBin)) out.claudeBin = DEFAULT_CLAUDE_BIN
  return out
}

export function claudeBinOf(host) {
  return isBinary(host.claudeBin) ? host.claudeBin : DEFAULT_CLAUDE_BIN
}

// A value of the wrong type falls back to its default, so a typo cannot turn into a tight loop or a bad ssh argv.
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isString = (v) => typeof v === 'string'
const isBoolean = (v) => typeof v === 'boolean'
const isPercent = (v) => isNumber(v) && v >= 0 && v <= 100
const SETTING_TYPES = {
  mode: (v) => v === 'orca-accounts' || v === 'engine',
  orcaApp: isBinary,
  drainIntervalMs: isNumber,
  maxToastsPerHostPerCycle: isNumber,
  drainEnabled: isBoolean,
  forceInstall: isBoolean,
  panelFace: (v) => v === 'dial' || v === 'clock' || v === 'list',
  panelView: (v) => v === 'session' || v === 'weekly',
  sshBin: isString,
  rsyncBin: isString,
  orcaBin: isBinary,
  orcaProfileDb: isBinary,
  sqliteBin: isBinary,
  // Optional: the name of a configured remote host whose Orca environment signs in for a Mac card. Absent means the first remote host.
  signinHost: (v) => v === undefined || isString(v),
  // Optional: the local Orca worktree a sign-in tab opens in, as an `id:` or `path:` selector. Absent means the first local one.
  signinWorkspace: (v) => v === undefined || (isString(v) && !v.trim().startsWith('-')),
  engineDir: isString,
  stateDir: isString,
  configDir: isString,
  sshOptions: (v) => Array.isArray(v) && v.every(isString),
}

// Each orcaAccounts key falls back on its own, so one typo does not reset the others.
function normaliseOrcaAccounts(value) {
  const d = DEFAULT_SETTINGS.orcaAccounts
  const v = isPlainObject(value) ? value : {}
  const t = isPlainObject(v.thresholds) ? v.thresholds : {}
  const environments = v.environments === 'all' || v.environments === 'none' || (Array.isArray(v.environments) && v.environments.every(isString))
    ? structuredClone(v.environments)
    : d.environments
  return {
    thresholds: {
      session: isPercent(t.session) ? t.session : d.thresholds.session,
      weekly: isPercent(t.weekly) ? t.weekly : d.thresholds.weekly,
    },
    environments,
    localName: isString(v.localName) && v.localName.trim() !== '' ? v.localName.trim() : d.localName,
  }
}

// Orca reaps an idle worker after five minutes, so the drain interval stays well under that.
const DRAIN_INTERVAL_RANGE = [30000, 240000]

export function mergeSettings(stored) {
  const over = isPlainObject(stored) ? stored : {}
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), over)
  const hosts = Array.isArray(over.hosts) ? over.hosts.map(normaliseHost).filter(Boolean) : []
  // An empty host list would leave nothing to target, so it falls back to the defaults.
  merged.hosts = hosts.length > 0 ? hosts : structuredClone(DEFAULT_SETTINGS.hosts)
  for (const [key, valid] of Object.entries(SETTING_TYPES)) {
    if (!valid(merged[key])) merged[key] = structuredClone(DEFAULT_SETTINGS[key])
  }
  merged.orcaAccounts = normaliseOrcaAccounts(merged.orcaAccounts)
  const [low, high] = DRAIN_INTERVAL_RANGE
  merged.drainIntervalMs = Math.min(high, Math.max(low, merged.drainIntervalMs))
  return merged
}

function targetIndex(settings) {
  const index = settings.hosts.findIndex((h) => h.name === settings.target)
  return index === -1 ? 0 : index
}

export function currentTarget(settings) {
  return settings.hosts[targetIndex(settings)]
}

// The host a command acts on: the target when the params name none (the palette), else the host they name, or null
// when that name is not a configured host, so a panel's command never runs on a host it did not ask for.
export function hostFor(settings, params) {
  if (!(isPlainObject(params) && typeof params.host === 'string')) return currentTarget(settings)
  return settings.hosts.find((h) => h.name === params.host) ?? null
}

export function nextTarget(settings) {
  const count = settings.hosts.length
  const index = (targetIndex(settings) + 1) % count
  return { host: settings.hosts[index], index: index + 1, count }
}

export function isRemote(host) {
  return typeof host.ssh === 'string' && host.ssh.length > 0
}

// The Orca environment a host's built-in browser belongs to: its orcaEnvironment, else its name for an ssh host, else none.
export function environmentOf(host) {
  const named = typeof host.orcaEnvironment === 'string' ? host.orcaEnvironment.trim() : ''
  if (named !== '' && !named.startsWith('-')) return named
  return isRemote(host) ? host.name : null
}

// Raw strings on purpose: the remote shell expands any leading ~/.
export function engineEnv(settings, host) {
  return {
    GRAZR_STATE_DIR: settings.stateDir,
    GRAZR_CONFIG_DIR: settings.configDir,
    GRAZR_NOTIFIER: host.notifier,
  }
}

export function forceInstallFor(settings, host) {
  return Boolean(host.forceInstall ?? settings.forceInstall)
}

export function enginePath(settings) {
  return `${settings.engineDir}/grazr.py`
}
