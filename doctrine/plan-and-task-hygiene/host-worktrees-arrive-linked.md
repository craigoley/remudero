- **On the Azure host a new worktree's dependencies are linked when it is cut — never run `npm ci` or `ln -s` node_modules in it.**

W1-T10507 prevents another private dependency install when a session uses raw `git worktree add`.
The 2026-10-23 host measurement found 57 real installs among 125 operator worktrees created over
eight days. At 511–537 MB each, those installs held about 30 GB; the namespace totalled 85 GB.
Seed-linked consumers measured about 2 MB. Prevention does not reclaim those existing installs.

The executable tracked `hooks/post-checkout` runs only for a new linked worktree: old HEAD is the
null sha, the checkout flag is 1, gitdir differs from the common gitdir, the kernel is not Darwin,
`package-lock.json` exists, and `node_modules` is absent. Files, directories, symlinks and dangling
symlinks all count as present. The account provisioner must resolve on PATH or at
`$HOME/.local/bin/remudero-dependencies`; otherwise the hook exits silently.

The hook primes from the first main-worktree entry in Git's porcelain worktree list. A donor-input
mismatch retries without a donor so the shared store can install that lockfile once. Other
refusals are reported without retrying. Success prints the method and seed key; refusal prints its
first line. Both leave `git worktree add` successful. The hook does not run for `--no-checkout`
cuts. Managed fleet cuts use `hooks/host` and retain their own dependency linking.

The host-unit installer checks the effective hooks directory for each live checkout. An unset
hooksPath is set to `hooks` only in install mode, as the service user. Explicit relative, absolute
and empty settings are preserved. Missing or non-executable hooks report MISSING; differing hooks
report DRIFTED and ask for the checkout to be brought to main. The installer never overwrites a
tracked hook in another checkout.

Compatibility probe, 2026-10-24, builder checkout b8e423ea4: a disposable clone and temporary seed
store materialized `readonly-links`, `installed: false`, key
`90905545b3235722261b2dffa55cae6285b0319825e6357a6efb7b20efecb9d3`.
The lane's own `node_modules` is a symlink, so using the lane as donor was refused with
“dependency seed donor must be a real install”. Its canonical dependency donor had the identical
input key and supplied the seed without changing the shared install.

| Command in the linked clone | Observed result |
| --- | --- |
| `npm ls --depth=0 --offline` | Exit 0; links retained, including packages npm labels extraneous |
| `npm run -s lint-plan:fast` | Exit 1; 57 task failures against the clone's stale `origin/main` merge base a89ed1c86249; links retained |
| `node --import tsx --import ./test/setup/tmp-hygiene.ts --test test/clock-port.test.ts` | Exit 0; 7 tests passed, 0 failed; links retained |
| `./bin/rmd preflight --fast` | Exit 143 / ETIMEDOUT at the 180-second probe bound; commitlint, typecheck and emitter phases returned, fast phase unfinished; links retained |

After all four commands, `du -sk node_modules` measured 1740 KiB and `node_modules/typescript`
was still a symlink. No observed command replaced the links. Plan lint's stale-base refusal and
the bounded preflight's incomplete result are known command refusals that could prompt a needless
reinstall; neither establishes a seed incompatibility. Repairing those commands is separate work.
This container probe does not identify what replaced the host's earlier registered consumers.

Builder verification on 2026-10-24 reran `./bin/rmd preflight --fast` in the lane itself:
26 steps passed and 2 failed in 530 seconds. Typecheck passed. The rule-checks and no-shallowing
steps could not load SWC because native-cache ancestry validation rejected the worker home and
temporary directory. The fixture-copy census also refused the new test being present on disk
but absent from Git's tracked-file list before harness staging. These are builder verification
limits, not observations of seed links being replaced; rerun after staging in a working runtime.
The explicit six-path census selection passed 32 of 33 suites; its only failure was SWC loading
in `test/no-shallowing-of-the-canonical-checkout.test.ts`.

Use `[ -L node_modules/typescript ]` to distinguish seed-linked packages from a real install;
`[ -L node_modules ]` instead detects the older whole-directory symlink. A subsequent symlink command
into an existing node_modules directory merely nests a link harmlessly. A clean install over seed
links is safe because it unlinks them before writing, but repays the full private install cost.

After rmd-op reaches a main containing the hook, an operator should count newly created `wt-*`
worktrees daily as seed links, real installs, directory symlinks or absent dependencies. Compare
bytes with the 57-in-eight-days baseline and name any linked-then-reinstalled worktree and timing.
The projected saving is up to about 520 MB per avoided install, not an observed reclamation.
