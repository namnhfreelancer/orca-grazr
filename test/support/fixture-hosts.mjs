import { mergeSettings } from '../../lib/hosts.mjs'

// The three-host fixture the tests use. The shipped default is the local Mac alone (lib/hosts.mjs).
export const FIXTURE_HOSTS = [
  { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' },
  { name: 'devbox', ssh: 'devbox', python: 'python3', notifier: 'queue' },
  { name: 'devbox-2', ssh: 'devbox-2', python: 'python3', notifier: 'queue' },
]

export const fixtureSettings = (overrides = {}) => mergeSettings({ hosts: FIXTURE_HOSTS, ...overrides })
