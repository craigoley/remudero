# Forensics: `deploy/host-update.sh` — section 4a, git object reclaim

The measured forensics and design arguments behind section 4a (W1-T3612), archived here when that
block was compacted to the plain-language standard (`docs/comment-standard.md`). `comment-load-ratchet`
refused the block at 32 lines and named this remedy: *"a `MEASURED ... on <date>` passage belongs in
`learnings/*.yaml` or a dated docs/ page, with a one-line pointer left in the code."*

Nothing here is a rule. The behaviour lives in the script, and the invariant, the trap and the
falsifier each stay in the code's own block — this page holds the measurement and the reasoning that
made the block long.

---

## The other filesystem

Everything above section 4a prunes docker, and docker lives on `/mnt/rmd`. The checkouts the fleet
owns — the daemon's own checkout and the operator's — live on the ROOT filesystem, and nothing above
touches it.

**Measured on the Azure host, 2026-09-15**, root at 85% (4.3 G free of 29 G):

    one checkout alone held 985 MiB across 53,380 LOOSE objects

behind a `.git/gc.log` that git will never clear on its own. Per `git-gc(1)`, once that file exists
automatic gc declines **forever** and does not retry.

`deploy/entrypoint.sh` already detects this on every boot and PRINTS the remedy without running it,
because (that file's own words) it *"cannot tell a stale log from one a maintenance run is still
writing."* This rung is the actor `entrypoint.sh` deliberately is not: it runs on the SAME schedule
as the docker reclaim above, not on every boot, so *"is a maintenance run still writing this"*
reduces to *"is the fleet running at all"* — which section 1 already answered, as `LIVE`.

**Corroborated 2026-09-16.** The host filled its root disk anyway, stopped forking `sshd`, dropped
the Cloudflare tunnel and kernel panicked — 89 minutes of fleet downtime, with
`systemd-journald: Failed to create new system journal: No space left on device` appearing in the
serial log across three separate boots. Git objects are one part of that fill; the larger part is
agent conversation history, filed separately as `W1-T3626`. Neither reclaim subsumes the other.

## This is git object reclaim, not state cleaning

The file header's "DO NOT ADD STATE CLEANING HERE" is scoped to the ledger/state **bind mount**
(`${STATE_DIR}/state/...`: `ledger.ndjson`, run locks, `service-tokens.json`), which section 4a never
reads, writes or measures. A checkout's `.git` object store is a different thing entirely, and
reclaiming it is this task's whole point.

## Why it refuses while the fleet is up, rather than carving out

`git gc` repacks and can prune objects a live lane still needs — a **sharper** hazard than the docker
image/build prune above. That prune cannot reach a running container's own image or cache at all,
which is why it is allowed to proceed under `--reclaim-only`. `git gc` has no such immunity: it
operates on the checkout directly. So section 4a reuses section 1's `LIVE` detection rather than the
docker prune's carve-out, and a refusal that NAMES the holder is the correct outcome — silently
skipping is not.

## Why each checkout is reported separately, never summed

A single combined total makes "0B reclaimed" ambiguous: nothing to do, or nothing to do on THIS
volume while a gigabyte sits on another? That ambiguity is exactly what let the docker-only reclaim
read as "disk attended to" while the root filesystem went untouched for a full 04:17 UTC cycle every
night.

## Why the checkout list is overridable rather than a growing set of literals

The two defaults are the checkouts MEASURED on the live host. `RMD_GIT_RECLAIM_DIRS`
(colon-separated) replaces the pair entirely for a host whose fleet owns a different set, so a third
checkout appearing later is a configuration change here, never a code change.
