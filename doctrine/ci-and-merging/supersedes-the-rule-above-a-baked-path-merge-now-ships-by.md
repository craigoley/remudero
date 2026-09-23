- **SUPERSEDES THE RULE ABOVE: a baked-path merge ships itself (auto ACR build + recycle); check
  `docker inspect`.** The rule above (frozen verbatim by the W1-T3323 migration fixture, so it
  cannot be edited) says an image rebuild waits on an operator running `acr-build.yml` by hand.
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

  **What the table above still gets right:** which half of a diff you are in. A mount path
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
  run, having read the rule above instead of `acr-build.yml` — the failure this rule prevents.

  **A baked change still reaches all three daemons at once**, because one image runs them all. A
  boot-time check in `deploy/entrypoint.sh` that refuses a condition one container is in takes
  that container down on the next recycle, with nobody pressing a button. Check the live
  containers for that condition before merging, not after. *(W1-T4195 / #6768, 2026-09-23)*
