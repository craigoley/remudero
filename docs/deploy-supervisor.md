# Deploy supervisor — self-updating the daemon

The daemon runs `tsx src/…` (loaded once at start) and dispatches **in-process**, so a
merged fix on `origin/main` is **inert until a full restart**, and
`KeepAlive{SuccessfulExit:false}` makes a clean self-restart impossible. Rather than
teach the daemon to restart itself, a **separate launchd job** (the supervisor) runs
the exact manual redeploy — fast-forward the daemon's checkout, then
`launchctl kickstart -k` the daemon — with the daemon itself never modified.

## Governance (defaults are conservative)
- **Human-gated by default.** A deploy runs only when an operator sets a marker
  (`rmd deploy` → `state/DEPLOY_REQUESTED`) **and** the install is behind `origin/main`.
  Craig gates merges today; the supervisor does **not** auto-deploy every green merge —
  that is an explicit opt-in (`state/DEPLOY_AUTO`) and only ever runs behind the health-check.
- **Idle-gated restart.** The restart is the dangerous half (in-process dispatch ⇒ a
  mid-task restart SIGKILLs the worker — the #559/#581 orphan class). The pull is safe
  anytime; the kickstart runs only at a verified idle gap (`no claude worker` +
  `state/inflight/` empty + no worktree lock), **re-checked in the same breath as the
  kickstart** to close the poll race.
- **Health-check + rollback.** After the kickstart the supervisor watches for a healthy
  `daemon.boot`. On a crash-loop it **rolls the checkout back to the prior HEAD**,
  restores the known-good daemon, and writes `state/DEPLOY_FAILED`. A bad merge CI didn't
  catch degrades to "last-good daemon running + alert", never a restart-storm.

## Install / enable
```sh
rmd deploy-plist --write            # writes ~/Library/LaunchAgents/com.remudero.supervisor.plist
launchctl load ~/Library/LaunchAgents/com.remudero.supervisor.plist
```
The unit runs `rmd deploy-run` every 120s (`--interval <s>` to change).

## Operate
```sh
rmd deploy --reason "ship #581"     # request a deploy at the next idle gap
rmd deploy-run --dry-run            # run one cycle WITHOUT restarting production (validation)
touch  <config.root>/state/DEPLOY_AUTO   # opt into auto-on-new-main (still health-checked)
rm     <config.root>/state/DEPLOY_AUTO   # back to human-gated
```
On failure, check `state/DEPLOY_FAILED` (the message + the failed HEAD); the install has
already been rolled back to the last-good commit and the daemon restored.
