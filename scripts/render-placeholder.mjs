// Writes panel/accounts.html from the template: the page shown before the first status run.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { placeholderPanel } from '../lib/panel.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const template = await readFile(`${root}panel/template.html`, 'utf8')
await writeFile(`${root}panel/accounts.html`, placeholderPanel(template))
console.log('wrote panel/accounts.html')
