# Vendored engine

These files are a copy of the grazr engine. Edit the engine in its own repository, then refresh this copy. Do not edit these files in place.

- Source: https://github.com/senadaruc/herdr-grazr
- Branch: `orca-port`
- Commit: `eea43440c46e9b743a880316979e3e8732d4962d`
- Engine version: `0.4.7+fork.10`
- Upstream: https://github.com/wazum/herdr-grazr (MIT, Wolfgang Klinger)

Vendored files: `grazr.py`, `claude.py`, `core.py`, `accounts.py`, `stores.py`, `atomic.py`, `pins.py`, `shim.py`, `LICENSE`.

`$ENGINE_REPO` is a checkout of the engine repository, and `$PLUGIN_REPO` is the root of this plugin. Refresh from a commit of the engine, not its working tree, which may be mid-edit:

```sh
ENGINE_REPO=/path/to/herdr-grazr
PLUGIN_REPO=/path/to/orca-account-autoswitch
COMMIT=$(git -C "$ENGINE_REPO" rev-parse HEAD)
for f in grazr.py claude.py core.py accounts.py stores.py atomic.py pins.py shim.py LICENSE; do
  git -C "$ENGINE_REPO" show "$COMMIT:$f" > "$PLUGIN_REPO/engine/$f"
done
```

Then update the commit and version above, and run `npm test`.
