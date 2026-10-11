- **A BAKED-path merge (`deploy/Dockerfile`, `deploy/entrypoint.sh`) ships itself by auto ACR build +
  recycle, not at merge — confirm with `docker inspect` before calling it shipped.** The frozen
  W1-T3323 rule below says an image rebuild waits on an operator running `acr-build.yml` by hand.
  Both halves of that stopped being true:

  - **The build.** `.github/workflows/acr-build.yml` runs on every push to `main` that touches
    `deploy/Dockerfile`, `deploy/entrypoint.sh`, `.dockerignore`, `deploy/package.json`,
    `deploy/package-lock.json`, `deploy/codex-requirements.toml` or `package-lock.json`
    (`workflow_dispatch` is still there for a manual build). Since #3967, 2026-09-04.
  - **The recycle.** The watchdog tick recycles a container whose image drifts from the newest
    published one (`src/lib/deployer.ts`, the `imageDriftOnly` arm). It respects STOP, waits for
    the image to be published, backs off for `IMAGE_RECYCLE_FAILURE_BACKOFF_MS` (an hour) after a
    failed deploy, and keeps the idle gate and health check. The operator's opt-out is the file
    `state/DEPLOY_IMAGE_MANUAL` (`deployImageManualPath`). Since #6647, 2026-09-22.

  **What the table below still gets right:** which half of a diff you are in. A mount path
  (`src/`, `test/`, `plan/`, `scripts/`) still ships through the daemon's freshness restart; a
  baked path still needs a NEW IMAGE. The difference is only who makes the image: now the fleet does.

  **How to tell a baked merge is live** — one command, run on the host:

  ```
  for c in remudero-daemon remudero-site-daemon remudero-console-daemon; do docker inspect --format '{{.Name}} created={{.Created}} image={{.Image}}' "$c"; done
  ```

  A container created after the merge's ACR build finished is running it. MEASURED 2026-09-23:
  #6768 (`deploy/entrypoint.sh`) merged at 15:32Z and built at 15:32Z; a later build at 16:43Z
  carried it; all three containers were recreated at 16:50–16:57Z on one image
  (`sha256:229f8859…`), with no operator action. A session had told the operator a rebuild was theirs to
  run, having read the rule below instead of `acr-build.yml` — the failure this rule prevents.

  **A baked change still reaches all three daemons at once**, because one image runs them all. A
  boot-time check in `deploy/entrypoint.sh` that refuses a condition one container is in takes
  that container down on the next recycle, with nobody pressing a button. Check the live
  containers for that condition before merging, not after. *(W1-T4195 / #6768, 2026-09-23)*

*(Index line merged 2026-10-11: the superseded W1-T3323 bullet below no longer ships beside its successor; its id resolves here through `doctrine/merged-rules.json`.)*

- **A merge to a BAKED path ships nothing until an operator triggers an image rebuild — know which
  half of your diff you are in before you call a merge "shipped."** On a container host the daemon
  runs from a **bind-mounted checkout** (`<state-root> -> .../Remudero`, the entrypoint `cd`s into
  it), while its own **entrypoint script and every apt-level binary come from the image**. A path
  read from the mount ships the instant it merges; a path baked into the image sits inert in a
  MERGED, GREEN-EVERYWHERE commit until `.github/workflows/acr-build.yml` (`workflow_dispatch`
  only, run by the operator from the Actions tab) is triggered and the new image is
  deployed. The failure mode is
  not a red check: docker still restarts the container, the daemon still logs `exited N`, and every
  diagnostic that reads the MOUNT still says the code is current — because it is; only the image is
  not. MEASURED 2026-08-14: the running image was 124 commits behind `origin/main`, including a
  Dockerfile fix and an entrypoint fix, neither showing as a failure off-host.

  | ships on merge (the mount) | needs an image rebuild (the image) |
  |---|---|
  | `src/`, `test/`, `plan/`, `scripts/`, `bin/` | `deploy/entrypoint.sh` — the EXECUTED entrypoint (`COPY … /usr/local/bin/rmd-entrypoint`) |
  | `deploy/*.sh` run BY THE OPERATOR from the checkout (`host-update.sh`, `verify-image.sh`) | `deploy/Dockerfile` itself — every apt binary (`jq`, `tini`, `bubblewrap`, `socat`), the node version, the `/app` snapshot |
  | `package.json` / the lockfile — via the mount and `ensureInstallFresh`, no rebuild needed | — |

  **`node_modules` resolves to the MOUNT, not the image** — `/app` carries its own that the
  entrypoint never falls back to, and the one the daemon loads is the same inode as the checkout's,
  so a dependency bump is a mount-side change. `scripts/fleet-heartbeat.sh` publishes
  `image_build_sha` (from `/etc/rmd-build-sha`) alongside the two checkout shas it already carried (`daemon_boot_head_sha`, `install_head_sha`) so this
  boundary is checkable from the beat without shelling into the host. *(W1-T496, 2026-08-14)*
