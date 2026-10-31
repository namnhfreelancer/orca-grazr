# Changelog

All notable changes to this plugin are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.6.2 - 2026-10-31

Needs Orca 1.4.245 or later. The bundled engine is `0.4.7+fork.11`.

Anthropic renamed the Max plans on 2026-10-30: Max 20x is now Ultra, and Max 5x is now Max.

### Changed

- Plan chips follow the rename. A Max plan at 20x reads `Ultra`, a Max plan at 5x reads `Max`, and any plan whose type or tier says `ultra` reads `Ultra`. Pro, Team and Enterprise are unchanged.
- An account with a current weekly reading and no 5-hour window reads `no 5-hour limit` on the 5h view, in the muted tone, instead of `no reading`. It is never shown as spent on the 5h view because of its missing 5-hour window. The dial's tooltip and centre say the same, and the active and next accounts keep their labels with the wording added.
- A host where no account has a 5-hour window, but some account has a live weekly reading, opens on Week whatever `panelView` says. Its 5h button still works and shows `no 5-hour limit`.
- The bundled engine is `0.4.7+fork.11`: a status line whose `five_hour` window is null or unusable keeps the weekly reading instead of dropping it.

## 0.6.1 (public) - 2026-10-31

First public release. It has the features of the development 0.6.1 below, with these differences:

### Changed

- The manifest is format 2 (`"manifestVersion": 2`, `"execution": "trusted-worker"`), needs Orca 1.4.245 or later, and is MIT licensed.
- The capabilities use the format 2 names (`storage:own`, `workspace:read`, `agent:read`, `terminal:send`, `notifications:show`, `settings:own`). `commands:execute` is no longer requested, since no released Orca offers it yet. The panel then types the command into the terminal instead, as it does on any Orca without the method.
- The worktree event is subscribed as `workspace.created`, the format 2 name for `worktree.created`.
- The default hosts are only the local Mac. Add ssh hosts in `settings.json`; the README explains how.
- The panel icon is `gauge`, one of the format 2 icon names.

The history below comes from the development repository.

## 0.6.1 (development) - 2026-10-31

Needs the same Orca as 0.6.0 (`commands.execute`). The bundled engine is `0.4.7+fork.10`.

### Added

- `Add account…` and `Re-authenticate…` sign in from the panel with no terminal. The plugin runs `claude auth login` on the Mac with a throwaway config directory, so your browser opens Claude's login. The card's message line shows `Sign in to … in your browser` at once; the outcome arrives as a toast and a refreshed card.
- The account is enrolled on the card's host: on the Mac from the throwaway login, and on a remote host by piping the login's export over ssh stdin. The throwaway login is discarded afterwards whatever the outcome.
- A sign-in that signs in as a different account than the card names enrols nothing and says which account signed in. A sign-in left unfinished for 10 minutes is abandoned, and a second sign-in for the same host waits for the first.
- The `claudeBin` setting, the Claude Code binary to run, default `claude`.

### Changed

- The bundled engine is `0.4.7+fork.10`: non-interactive `enrol --from` and `enrol --stdin`, `login-export` and `login-discard`.
- The panel's enrol no longer opens a Terminal window. From the palette, `enrol` still types into the newest terminal.

### Removed

- The `terminalApp` setting and `lib/terminal-window.mjs`.

## 0.6.0 - 2026-10-30

Needs an Orca with the `commands.execute` host method (capability `commands:execute`), proposed upstream and not in any stock release yet; until it ships that means a local Orca build with the change. Stock Orca rejects this manifest; use 0.5.x there.

### Added

- The panel's buttons run their command on the host the card names, and the result shows on the card's message line. Refresh, Swap, Turn rotation on or off and Refresh panel no longer type into a terminal.
- `Add account…` and `Re-authenticate…` open a Terminal window that runs the enrol command on that card's host, with two lines saying what to press. The window opens in the app named by the `terminalApp` setting, which defaults to `Terminal`.
- A `Refresh panel` action on each card.
- The `terminalApp` setting.
- Commands take params from the panel: `swap` with an `account`, `refresh` and `uninstall` with a `host`, and `rotation-toggle` with an `enabled` boolean. A missing or unknown `host` falls back to the target, so the palette behaves as before.

### Changed

- Every command resolves to `{ ok, message }` with the same text it toasts, so the panel can show the result.
- The panel asks for a refresh whenever it is opened on a page older than three minutes, not only after an Orca restart. That refresh raises no notification; the card's message line shows its outcome.
- The parked accounts' Refresh button is labelled `Refresh parked`.

### Unchanged

- From the palette, `enrol` and `status-terminal` still type into the newest terminal of the focused worktree.

## 0.5.0 - 2026-10-22

### Added

- A `List` face, switched with a `Dial | Clock | List` control. It shows one card per account with a bar per usage window (5h, Week, and each per-model week when model limits are on), with the percentage left and its tone, the reset time, the Active and Blocked chips, the organisation, the reading age (which updates in the page), and the Switch and Re-authenticate… buttons. Re-authenticate… is offered on a blocked account even while it is active.
- `panelFace` accepts `list` as well as `dial` and `clock`.
- The engine's `status --json` accounts carry `organization`.
- The engine's `status --json` accounts carry `plan`.
- A plan chip on each account's head in the List face, such as `Max 20x`, `Team 5x` or `Pro`.
- Tooltips on the dial's segments: the account, its percentage left, the swap threshold and the reset time.
- Per-model inner rings on the dial's Week view when model limits are on, with their own tooltips, the active account's per-model lines in the centre, and the `Outer ring: all models · inner: …` footnote.

### Changed

- The bundled engine is `0.4.7+fork.9`.
- The panel's background is Orca's card colour, matching the sidebar.
- The big-page guard is 1.25 MB: the 300-account test fixture renders 1.13 MB with two model rings per account; a real panel is a few accounts.

## 0.4.0 - 2026-10-22

### Added

- A `Clock` face on each card, switched with a `Dial | Clock` control. On the 5h view it shows a 24-hour face, and on the Week view a 7-day face. The hand sits at now and the local time is in the centre. The ring ahead of the hand is coloured by the account grazr is projected to be on, and it is red where nothing can run. Swaps are ticks across the ring, and refills are numbered dots outside it.
- `panelFace` and `panelView` settings choose the face and window each card opens with; the toggles switch every card at once and hold until the page is next rewritten.

### Changed

- The bundled engine is `0.4.7+fork.7`. Its `status --json` carries each account's reading time, which the clock needs for its pace. Until the engine is reinstalled on a host, the card shows `engine update available` and the clock projects without pace.
- The bundled engine's version suffix is `+fork.N` instead of the earlier suffix.
- The `5h | Week` toggle now switches every card at once.

## 0.3.1 - 2026-10-22

### Added

- A needle on each card's ring at what the active account has used, and a tick at the swap threshold on the active slice.

### Changed

- The active slice's track is dimmed, and its remaining arc runs from the needle to the slice end in the tone colour, as in HerdrM.

## 0.3.0 - 2026-10-22

### Added

- Per-host header line in the panel, with the swap thresholds and the time the page last changed with a fresh reading of that host.
- Engine version line in each card, and an `engine update available` chip when the installed engine version differs from the bundled version.
- `Turn rotation on` / `Turn rotation off` button in each card, which types the rotation command into the newest terminal.
- Stock-Orca install guide in the README, for installing from a path and from a git URL.

### Changed

- The ring and the account rows are coloured by account state, as in the native dialog: green for accounts with tokens, red when out of tokens, orange and dashed for the next account, grey for parked or unknown.
- The centre text of the ring stays inside the ring.
- The footer is reduced to the `Cmd-J Grazr: Refresh panel` hint.
- An unchanged page is no longer rewritten when only the minute changes.

## 0.2.0 - 2026-10-21

### Added

- Claude Accounts panel in Orca's sidebar, with one card per host, a 5h and Week view, and buttons for refresh, add account, swap to next, swap to a named account and re-authenticate a blocked account.
- `Grazr: Refresh panel` command, which regenerates the panel and reports whether the page was updated, unchanged, not writable or failed.
- Panel regeneration after each drain tick and after each command that changes a host.
- Status command hands its results to the panel, so each press asks every host once.

## 0.1.0 - 2026-10-21

### Added

- Plugin manifest for `senadaruc.grazr` with ten palette commands, two events (`agent.status.changed`, `worktree.created`) and six capabilities.
- Host settings with defaults, merged over whatever Orca stores and seeded on first activation.
- Running the grazr engine locally or over `ssh`, with JSON status and line-based command output.
- Deploying the engine to each host with `rsync`, excluding bytecode and test files.
- Install, uninstall, swap, refresh and rotation toggle on the target host, with OS toasts for each result.
- Status across all hosts, with each host's failure isolated so one unreachable host does not hide the others.
- Install refuses a status line owned by another grazr unless `forceInstall` is set, globally or per host, and gives up when its time budget expires.
- A per-host `forceInstall` override, so taking over Herdr's status line on one remote box leaves the Mac alone.
- The Mac host notifies through `osascript` by default. Hosts whose notifier includes `queue` are drained, so each notice shows once.
- Drain loop that delivers engine notices as OS notifications every `drainIntervalMs`, with per-host isolation, backoff for unreachable hosts and a cap on toasts per cycle.
- Palette commands that type the enrol and status commands into a shell terminal in a worktree.
- Engine failures are classified (timeout, missing binary, unreachable host, engine error) and reported with the host name.
