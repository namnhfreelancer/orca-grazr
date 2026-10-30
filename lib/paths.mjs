// Local spawns get no shell to expand ~, so the plugin does it itself with the injected home directory.
export function expandTilde(path, homedir) {
  return path.startsWith('~/') ? homedir() + path.slice(1) : path
}
