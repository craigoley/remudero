# 0003. Build and run the daemon as an ACR-built container image

Status: Accepted
Date: 2026-08-07

## Context

The daemon needs a runtime image, but no agent container in this project's
own build environment has a local Docker daemon — building `deploy/Dockerfile`
directly was never an option here. PR #1478 (2026-08-07, "build the image in
ACR, copying SynthWatch's proven path") added `.github/workflows/acr-build.yml`
to solve it by building on Azure's fleet instead of locally. The workflow's
own header states the source and the reasoning:

> Copied from `craigoley/synthwatch`'s `.github/workflows/deploy.yml`, which
> has been building that project's runner image this way in production:
> `azure/login` with an OIDC federated credential, then `az acr build` inside
> the `azure/cli` action ... "no Azure secrets stored in the repo; only the
> non-sensitive client/tenant/subscription IDs are repo vars."
> `az acr build` is an ACR TASK: the build runs on Azure's fleet from an
> uploaded source context. NO LOCAL DOCKER DAEMON IS INVOLVED ANYWHERE.

The workflow is deliberately `workflow_dispatch`-only for commissioning, plus
a push trigger scoped to the two paths that are actually baked into the image
(`deploy/Dockerfile` and the entrypoint) — the workflow's own header states
it "BUILDS. IT DEPLOYS NOTHING": no `az containerapp` step exists, because
the persistent-volume question for `rmd`'s state directory (an `O_EXCL`
inflight lock, an atomic-rename ledger rotation — neither reliably supported
by an SMB share) is unsettled, and provisioning ahead of that would be
premature.

This produces the mount-vs-image split CLAUDE.md's "CI and merging" section
documents: the running daemon binds the checkout via a bind mount (so
`src/`, `plan/`, `scripts/`, `bin/`, and even `node_modules` via the mount
ship the instant a merge lands), while `deploy/entrypoint.sh` and everything
`apt`-installed in `deploy/Dockerfile` are baked into the image and sit
inert — even in a merged, all-green commit — until an operator dispatches
`acr-build.yml` and redeploys. MEASURED 2026-08-14 (W1-T496): the running
image was 124 commits behind `origin/main`, including a Dockerfile fix and
an entrypoint fix, with nothing off-host reading as a failure, because it
wasn't one — only the image was stale.

## Decision

The daemon's runtime is a container image built from `deploy/Dockerfile` by
`.github/workflows/acr-build.yml` as an Azure Container Registry (ACR) Task
running on Azure's build fleet, dispatched by an operator (or triggered on a
push touching the Dockerfile/entrypoint), never built by a local Docker
daemon anywhere in this pipeline. The workflow builds and pushes an image;
it does not deploy or provision compute.

## Consequences

- A code change that ships on the mount (almost everything) is live the
  instant it merges; a change to `deploy/Dockerfile` or `deploy/entrypoint.sh`
  is not live until someone manually dispatches a rebuild — this asymmetry is
  the single most common way to misjudge "shipped" in this repo, per CLAUDE.md.
- Reproducing this deployment path on a fresh Azure subscription needs two
  operator-only, portal-side prerequisites the workflow cannot self-provision:
  a federated-credential subject scoped to `craigoley/remudero` on the app
  registration, and an `AcrPush` role assignment on the target registry — the
  workflow's own header flags these as unverified from CI ("the Azure CLI is
  not available to the session that wrote this file").
- No persistent-volume/provisioning story exists yet for `rmd`'s state
  directory, so this ADR covers *building* the image only; a follow-on
  decision (unwritten as of this ADR) will be needed once actual container
  provisioning is decided.

**How to reverse:** dropping ACR for a different build path (a self-hosted
runner with Docker, a different registry/cloud) means rewriting
`acr-build.yml`'s login and build steps and re-provisioning the two Azure
prerequisites' equivalents elsewhere; it does not touch `deploy/Dockerfile`
itself or the mount-vs-image split, so the cost is confined to one workflow
file and its cloud-side credentials, not a code or data migration.
