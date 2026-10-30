import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quote, quoteTilde, join } from '../lib/shell-quote.mjs'

test('quote passes through safe arguments unchanged', () => {
  assert.equal(quote('plain-arg_1./:=,+@%'), 'plain-arg_1./:=,+@%')
})

test('quote wraps arguments with spaces in single quotes', () => {
  assert.equal(quote('a b'), "'a b'")
})

test('quote escapes an embedded single quote', () => {
  assert.equal(quote("it's"), `'it'\\''s'`)
})

test('quote turns the empty string into two single quotes', () => {
  assert.equal(quote(''), "''")
})

test('quote rejects non-string arguments instead of coercing them', () => {
  assert.throws(() => quote(undefined), TypeError)
  assert.throws(() => quote(42), TypeError)
})

test('quoteTilde rejects non-string arguments', () => {
  assert.throws(() => quoteTilde(undefined), TypeError)
})

test('quoteTilde keeps the leading ~/ outside the quotes', () => {
  assert.equal(quoteTilde('~/x y'), "~/'x y'")
})

test('quoteTilde leaves a safe tilde path unquoted', () => {
  const p = '~/.local/share/orca-grazr/engine/grazr.py'
  assert.equal(quoteTilde(p), p)
})

test('quoteTilde quotes a non-tilde path with spaces', () => {
  assert.equal(quoteTilde('/abs path'), "'/abs path'")
})

test('join quotes each argument and separates them with spaces', () => {
  assert.equal(
    join(['python3', '/x y/z.py', '--flag', "a'b"]),
    `python3 '/x y/z.py' --flag 'a'\\''b'`,
  )
})
