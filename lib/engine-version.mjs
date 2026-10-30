import * as nodeFs from 'node:fs/promises'
import { describe } from './errors.mjs'

// The engine version the plugin ships: the VERSION line of engine/grazr.py.
const VERSION_LINE = /^VERSION = "([^"]+)"/m

// Rejects with the path when the engine cannot be read or has no VERSION line, so the caller can log it.
export async function readBundledVersion({ root, fs = nodeFs }) {
  const path = `${root}/engine/grazr.py`
  let source
  try {
    source = await fs.readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read the bundled engine at ${path}: ${describe(err)}`)
  }
  const match = source.match(VERSION_LINE)
  if (!match) throw new Error(`no VERSION line in the bundled engine at ${path}`)
  return match[1]
}
