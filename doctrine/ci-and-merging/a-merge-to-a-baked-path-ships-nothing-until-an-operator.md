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
