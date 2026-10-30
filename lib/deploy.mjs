import os from 'node:os'
import { execCapture } from './exec.mjs'
import { expandTilde } from './paths.mjs'
import { isRemote } from './hosts.mjs'
import { join, quoteTilde } from './shell-quote.mjs'
import { describeFailure } from './errors.mjs'
import { ok } from './runner.mjs'

// Compiled bytecode and test files do not belong in the installed engine.
const RSYNC_FLAGS = ['-a', '--delete', '--exclude', '__pycache__', '--exclude', 'test_*']

// Stable path on every host: an installed plugin lives in a hash directory that changes per update.
export function createDeploy({ settings, exec = execCapture, homedir = os.homedir, root }) {
  const source = `${root}/engine/`

  function commands(host) {
    if (!isRemote(host)) {
      const dir = expandTilde(settings.engineDir, homedir)
      return [
        ['/bin/mkdir', '-p', dir],
        [settings.rsyncBin, ...RSYNC_FLAGS, source, `${dir}/`],
      ]
    }
    // rsync resolves a relative remote path against the login home, so the leading ~/ is dropped.
    const remoteRelative = settings.engineDir.replace(/^~\//, '')
    const sshCommand = join([settings.sshBin, ...settings.sshOptions])
    return [
      [settings.sshBin, ...settings.sshOptions, host.ssh, `mkdir -p ${quoteTilde(settings.engineDir)}`],
      [settings.rsyncBin, ...RSYNC_FLAGS, '-e', sshCommand, source, `${host.ssh}:${remoteRelative}/`],
    ]
  }

  async function deploy(host, { timeoutMs = 15000 } = {}) {
    const steps = commands(host)
    for (const [step, argv] of steps.entries()) {
      const result = await exec(argv, { timeoutMs })
      if (!ok(result)) {
        return {
          ok: false,
          step,
          failure: describeFailure({ ...result, remote: isRemote(host) }),
          result,
        }
      }
    }
    return { ok: true }
  }

  return { deploy, commands }
}
