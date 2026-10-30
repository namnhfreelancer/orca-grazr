// Worker entry. Orca calls activate once per worker; the plugin wiring lives in lib/plugin.mjs.
import { createGrazrPlugin } from './lib/plugin.mjs'
import { pluginRoot } from './lib/plugin-root.mjs'

let plugin = null

export default async function activate(orca) {
  plugin = await createGrazrPlugin({ orca, root: pluginRoot() })
}

export function deactivate() {
  plugin?.deactivate()
  plugin = null
}
