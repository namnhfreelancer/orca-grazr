const SAFE = /^[A-Za-z0-9_./:=,+@%-]+$/

// Coercing a non-string would turn a missing field into the literal word "undefined".
export function quote(arg) {
  if (typeof arg !== 'string') throw new TypeError(`quote expects a string, got ${typeof arg}`)
  if (arg === '') return "''"
  if (SAFE.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

// The leading ~/ must stay outside the quotes, or the remote shell never expands it.
export function quoteTilde(arg) {
  if (arg.startsWith('~/')) return `~/${quote(arg.slice(2))}`
  return quote(arg)
}

export function join(args) {
  return args.map(quote).join(' ')
}
