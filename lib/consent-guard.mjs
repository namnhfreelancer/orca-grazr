// Notices when Orca has withdrawn the plugin's approval and starts consent-heal.cjs to restore it.
//
// After an Orca restart a plugin whose manifest no longer matches its stored approval keeps running, but every host
// call fails with consent_required ("plugin is not enabled with current consent"): no settings, no storage, no
// notifications, so the rotation silently stops. The heal runs detached, because disabling the plugin stops this
// worker, and it renews the approval only for the access the manifest declares.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HEAL_PATH = fileURLToPath(new URL('./consent-heal.cjs', import.meta.url))
// One heal at a time, and not again soon after: a heal that cannot fix it must not loop.
export const HEAL_GAP_MS = 15 * 60000

export const isConsentRefusal = (err) => err?.code === 'consent_required' || /not enabled with current consent/i.test(String(err?.message ?? err))

export function createConsentGuard({ root, spawn, orcaApp = '/Applications/Orca.app', orcaBin = '/usr/local/bin/orca', pluginKey = 'senadaruc.grazr', now = Date.now, log = () => {}, readManifest = () => JSON.parse(readFileSync(`${root}/orca-plugin.json`, 'utf8')) }) {
  let lastHealAt = -Infinity

  function trip() {
    if (now() - lastHealAt < HEAL_GAP_MS) return false
    lastHealAt = now()
    let manifest
    try {
      manifest = readManifest()
    } catch (err) {
      log(`grazr: approval withdrawn, and the manifest is unreadable: ${err?.message ?? err}`)
      return false
    }
    const capabilities = (manifest.capabilities ?? []).map((c) => c.kind).filter(Boolean).join(',')
    const electron = `${orcaApp.replace(/\/+$/, '')}/Contents/MacOS/Orca`
    log('grazr: Orca withdrew the approval; renewing it for the access the manifest declares')
    const child = spawn(electron, [HEAL_PATH, orcaBin, pluginKey, manifest.execution ?? '', capabilities], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on?.('error', (err) => log(`grazr: could not start the approval renewal: ${err?.message ?? err}`))
    child.unref?.()
    return true
  }

  return { trip }
}
