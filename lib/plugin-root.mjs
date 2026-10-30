import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Orca's SDK does not expose the install directory, so derive it from this file's location.
export function pluginRoot(importMetaUrl = import.meta.url) {
  return dirname(dirname(fileURLToPath(importMetaUrl)))
}
