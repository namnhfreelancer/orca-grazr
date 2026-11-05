'use strict'
// Restores the plugin's approval after Orca withdrew it, run detached by the worker (which the disable stops).
//
// Orca binds an approval to the manifest; after a restart it compares the stored approval with the manifest on
// disk, and a mismatch leaves the plugin running with every host call refused ("not enabled with current consent").
// `orca plugin enable` alone then reports success, so the approval is renewed the way a person would: disable,
// enable, and approve the fingerprint Orca asks for, but only when the grants it asks for are exactly the ones the
// manifest declares (same execution level, same capabilities). Anything more is left to you, with a notification.
//
// argv: <orca CLI> <plugin key> <execution> <capability,capability,...>
const { execFileSync } = require('node:child_process')

const [orcaBin, pluginKey, execution, capabilityList] = process.argv.slice(2)
const expected = (capabilityList || '').split(',').filter(Boolean).sort()

function orca(args) {
  try {
    return JSON.parse(execFileSync(orcaBin, [...args, '--json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (err) {
    const text = String(err.stdout || '')
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, error: { code: 'cli_failed', message: String(err.message).split('\n')[0] } }
    }
  }
}

function notify(title, body) {
  if (process.platform !== 'darwin') return
  const quote = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${quote(body)} with title ${quote(title)}`], { timeout: 10000 })
  } catch {}
}

function main() {
  orca(['plugin', 'disable', pluginKey])
  const asked = orca(['plugin', 'enable', pluginKey])
  if (asked.ok) return notify('Grazr', 'Orca had withdrawn Grazr\'s approval; it is enabled again.')
  const data = asked.error?.data ?? {}
  const fingerprint = data.approvalFingerprint
  const grants = data.grants ?? {}
  const granted = (grants.capabilities ?? []).map((c) => c.kind).sort()
  const same = grants.execution === execution && JSON.stringify(granted) === JSON.stringify(expected)
  if (asked.error?.code !== 'approval_required' || !fingerprint || !same) {
    return notify('Grazr needs your approval', 'Orca withdrew Grazr\'s approval and asks for different access. Approve it in Settings › Plugins.')
  }
  const approved = orca(['plugin', 'enable', pluginKey, '--approve', fingerprint])
  if (approved.ok) return notify('Grazr', 'Orca had withdrawn Grazr\'s approval after a restart; it was approved again with the same access.')
  notify('Grazr needs your approval', `Re-approving failed (${approved.error?.message ?? 'no answer'}). Approve it in Settings › Plugins.`)
}

main()
