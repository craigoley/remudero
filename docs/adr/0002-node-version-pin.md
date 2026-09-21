# 0002. Pin Node to an exact version, everywhere, no floating tags

Status: Accepted
Date: 2026-09-03; digest hardening updated 2026-09-21

## Context

`.nvmrc` (`22.22.3`) and `package.json#engines.node` (`>=22.22.3`) both date
to the initial scaffold commit (PR #1, 2026-07-14) — OBSERVED via
`git log -S'22.22.3' -- .nvmrc`, which resolves to that commit. But the
container image did not match that discipline: `deploy/Dockerfile` carried a
**floating** tag, `FROM node:22-bookworm-slim`, until PR #3809 (W1-T2770,
2026-09-03).

That gap caused a real outage. PR #3809's own commit message records it:

> `deploy/Dockerfile`'s `FROM node:22-bookworm-slim` is a floating tag. It
> drifted to Node 22.23.2 while `.nvmrc` pins 22.22.3 ... The six
> `test/merge-lcov.test.ts` coverage-merge-CLI failures MEASURED at 22.23.2
> vs 22.22.3 are that throw surfacing six times; Node arrived through the
> floating tag with no file change in this repo.

The "throw" is `assertPinnedNodeVersion()` (`scripts/coverage-merge-ratchet.mjs`,
added PR #3516, 2026-09-01), which refuses to merge raw V8 coverage unless
`process.versions.node` exactly equals the trimmed contents of `.nvmrc` —
deliberately fail-closed on ANY string mismatch, not just a semver-incompatible
one, because Node's own coverage-report internals are not guaranteed stable
across patch releases.

## Decision

Node's version is pinned **exactly**, in lockstep, in every place a Node
runtime is chosen for this project: `.nvmrc` (source of truth),
`package.json#engines.node`, and `deploy/Dockerfile`'s `FROM` tag. The
Dockerfile now adds the verified multi-platform manifest digest, and the
`/deploy` Docker and npm Dependabot entries renew the image digest and the
image-local CLI lockfile. `assertPinnedNodeVersion` enforces the `.nvmrc`
half of this at the coverage-merge seam; PR #3809 closed the version-tag
half by changing `FROM node:22-bookworm-slim` to the exact 22.22.3 tag and
adding a `HostFacts`-driven `node-version-drift-from-pin` cluster
(`src/lib/ci-parity.ts`) that fires loud the moment the pin and the running
Node disagree again.

## Consequences

- Bumping Node requires a coordinated, same-commit edit to `.nvmrc`,
  `package.json#engines`, and `deploy/Dockerfile`'s `FROM` line — the
  Dockerfile's own comment states this explicitly ("bump both this tag AND
  `.nvmrc` in the same commit; the cluster's self-expiry then re-arms itself
  around the new pin the moment the image lands").
- A Dockerfile-only change ships inert until an operator dispatches
  `acr-build.yml` (see ADR 0003) — a version bump is not "live" the instant
  it merges, which is easy to forget and was part of what let the drift
  happen unnoticed the first time.
- Dependabot owns routine digest renewal, so the image no longer floats
  during a build while still receiving reviewed base-image updates. A Node
  version bump remains a coordinated change to `.nvmrc`, the tag, and the
  digest, followed by the operator-triggered image rebuild.

**How to reverse:** reverting to a floating tag is a one-line Dockerfile
edit, but it reopens exactly the outage this ADR records, silently, since
nothing else in the pipeline would catch a drift outside the coverage-merge
seam `assertPinnedNodeVersion` guards. Reversal is cheap to type and
expensive to trust.
