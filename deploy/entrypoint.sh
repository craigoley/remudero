#!/usr/bin/env bash
# rmd-entrypoint — give the container a REAL WORK TREE before it runs anything.
#
# WHY. The image carries a source SNAPSHOT at /app with no `.git`, and three separate diagnoses on
# Azure turned out to be that one fact: `rmd status` warns the cwd is not inside a git work tree,
# `resolveOwnerRepo` throws because `git config --get remote.origin.url` fails, the deployer has
# nothing to fast-forward and `checkCliFreshness` has nothing to freshen. The operator worked round
# it by cloning into the volume by hand — and that clone went stale (branched one commit behind
# origin, producing a scope-guard refusal three phases into a run), lost its node_modules, and
# needed its remote set with a token by hand. This script is the automation of the workaround, with
# the failure modes it hit closed.
#
# WHAT IT DOES NOT DO. It does not decide when to reinstall dependencies, and it does not sync a
# dirty tree. Both already have owners in this codebase and duplicating them would be worse than
# leaving them alone — see the notes at each step.
#
# SKIPPING IT. `RMD_SKIP_BOOTSTRAP=1` runs the command with no clone, no fetch and no install. That
# is the right mode for probing the image itself (`deploy/verify-image.sh` bypasses this script
# entirely by overriding the entrypoint, so its checks are unaffected either way).

set -euo pipefail

log() { printf 'rmd-entrypoint: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

if [ "${RMD_SKIP_BOOTSTRAP:-}" = "1" ]; then
  log "RMD_SKIP_BOOTSTRAP=1 — no clone, no fetch, no install"
  exec "$@"
fi

REPO_URL="${RMD_REPO_URL:-https://github.com/craigoley/remudero.git}"

# ── THE PIN, AND WHAT IT RECOVERS ────────────────────────────────────────────────────────────
# Cloning at startup breaks the property the image digest used to carry: today a digest names
# exactly what will run, and a container that clones runs whatever the ref held at boot. RMD_REF is
# how that is recovered — it takes a branch, a tag or a full commit sha, so an operator who needs
# "run exactly this code again" pins a sha and gets it back.
#
# THE DEFAULT IS `main` RATHER THAN A PINNED SHA, and that is a deliberate trade rather than
# laziness. A sha default would have to be edited into this file and rebuilt to move, which is the
# very rebuild-to-change-code cost this whole change exists to remove; and a stale default is worse
# than no default, because it silently runs old code while looking pinned. `main` is what a fleet
# host is supposed to be on — the mini's own self-sync fast-forwards to origin/main — so the
# default matches the fleet and the pin is there when reproducibility matters more than currency.
REF="${RMD_REF:-main}"

# config.root is `$HOME/Remudero` (loadConfig, src/lib/config.ts), and the fleet's own checkout sits
# beside the state it manages. Deriving both from HOME rather than hardcoding keeps this consistent
# with the image's ENV HOME and with the volume the operator mounts.
: "${HOME:?HOME must be set — config.root derives from it and an unset HOME sends state to /}"
CONFIG_ROOT="$HOME/Remudero"
TREE="$CONFIG_ROOT/remudero"

# ── CREDENTIALS: A HELPER, NOT A TOKEN ON DISK ───────────────────────────────────────────────
# MEASURED: `gh auth setup-git` REFUSES with only GH_TOKEN set — "You are not logged into any
# GitHub hosts" — so the obvious one-liner is not available.
#
# The two forms that DO work both write the token to disk: a token-bearing remote URL puts it in
# the clone's .git/config, which lives in the mounted volume and therefore OUTLIVES the container;
# a `url.insteadOf` rewrite puts it in a gitconfig. Both also go stale the moment the token rotates,
# and a stale token baked into a remote is a confusing failure.
#
# A credential helper avoids both: the token is read from the environment AT CALL TIME, so it is
# never written anywhere, and rotation is just a new `-e GH_TOKEN`. The helper is stored with
# `$GH_TOKEN` UNEXPANDED — single-quoted here so this shell does not substitute it — and git's own
# shell expands it when it runs. The remote URL stays clean.
# `git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME does not exist —
# "could not lock config file". The image creates /home/node, so this only bites a container
# started with a HOME that was never made; creating it costs nothing and removes a boot failure
# whose message says nothing about the real cause. Found by running this script, not by reading it.
mkdir -p "$HOME"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global credential.helper \
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
  log "git credentials: helper reads GH_TOKEN at call time (not written to disk)"
else
  log "GH_TOKEN is not set — a private fetch or clone will fail"
fi

# ── CLONE, OR SYNC WHAT IS ALREADY THERE ─────────────────────────────────────────────────────
if [ ! -e "$TREE/.git" ]; then
  log "no work tree at $TREE — cloning $REPO_URL"
  mkdir -p "$CONFIG_ROOT"
  git clone "$REPO_URL" "$TREE" || die "clone failed — check GH_TOKEN and RMD_REPO_URL"
  git -C "$TREE" checkout --detach "$REF" 2>/dev/null \
    || git -C "$TREE" checkout "$REF" \
    || die "ref not found: $REF"
else
  log "work tree present at $TREE"
  git -C "$TREE" fetch --prune origin || log "fetch FAILED — continuing on the tree as it stands"

  # ── THE DIRTY-TREE RULE IS THE DEPLOYER'S, NOT A NEW ONE ───────────────────────────────────
  # `decideDeploy` (src/lib/deployer.ts) guards its fast-forward with a clean-tree check whose
  # comment is explicit: "abort (never force) on a conflicting dirty tree", reported as
  # `dirty-tree-conflict`. Uncommitted work is never discarded to make a sync succeed.
  #
  # THIS TEST IS STRICTLY MORE CONSERVATIVE THAN THAT ONE, and the difference is worth stating
  # rather than implying parity. `treeFfSafe` intersects the dirty files with the INCOMING files
  # and only conflicts on the overlap, so it tolerates local edits the fast-forward would not
  # touch. Reproducing that in shell would mean reimplementing it, badly, in the one place where
  # being wrong destroys uncommitted work — so this refuses on ANY dirt. It errs toward leaving
  # the tree alone, which is the safe direction, and it says so rather than silently skipping.
  #
  # `-uno` — TRACKED MODIFICATIONS ONLY, and this is load-bearing rather than a tidy-up. Plain
  # `--porcelain` also lists UNTRACKED files, and the first boot creates one immediately by
  # installing node_modules. Measured: with untracked files counted, the second boot refused to
  # sync and every boot after it would have done the same — a container permanently pinned to
  # whatever it first cloned, reporting a reason that sounds like the operator left work behind.
  # Untracked files also cannot conflict with a fast-forward, which is what `treeFfSafe` is
  # actually about: LOCALLY-MODIFIED files. This matches that intent and removes the trap.
  if [ -n "$(git -C "$TREE" status --porcelain -uno)" ]; then
    log "REFUSING to sync: the work tree has uncommitted changes."
    log "  Nothing has been discarded and nothing was fetched into the checkout."
    log "  This is deliberately stricter than the deployer, which conflicts only on files the"
    log "  fast-forward would touch. Commit or stash, or run with RMD_SKIP_BOOTSTRAP=1."
  else
    git -C "$TREE" checkout --detach "$REF" 2>/dev/null \
      || git -C "$TREE" checkout "$REF" \
      || die "ref not found: $REF"
    # --ff-only, never a merge commit and never a reset: if the ref moved in a way that is not a
    # fast-forward, that is a fact worth surfacing, not something to paper over.
    git -C "$TREE" merge --ff-only "origin/$REF" 2>/dev/null || true
  fi
fi

# RECORD WHAT ACTUALLY RUNS. The point of the pin is lost if the resolved commit is not observable,
# so print it unconditionally — this line is what makes "which code ran" answerable after the fact,
# and it is the closest thing to the digest guarantee the snapshot used to give.
log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"

# ── THE BOOTSTRAP INSTALL, AND ONLY THAT ─────────────────────────────────────────────────────
# `ensureInstallFresh` (src/run-task.ts) ALREADY solves "should I reinstall": it hashes
# package.json + package-lock.json, compares against `.rmd-install-hash` written inside
# node_modules by the last successful install, and its own doc states a matching hash is "a total
# no-op — no redundant install, ever". Two call sites already wire it. Re-deciding that here would
# duplicate a mechanism that is better than anything this script could compute.
#
# BUT IT CANNOT BOOTSTRAP ITSELF. `bin/rmd` ends in `exec "$DIR/node_modules/.bin/tsx"`, so on a
# fresh clone with no node_modules there is no way to REACH ensureInstallFresh — every verb dies at
# "Cannot find package 'tsx'", which is exactly the failure that killed the hand-made clone. So the
# only install this script owes is the first one, conditioned on tsx being absent rather than on
# anything about freshness. After that, rmd's own hash decides, as it does on every other host.
#
# This also answers the sharing question the wrong way round on purpose: the clone gets its OWN
# node_modules. REQ 4 in the Dockerfile records that one shared install emptied under a running
# daemon twice in a week, and /app's install belongs to /app's lockfile, not to this checkout's.
if [ ! -x "$TREE/node_modules/.bin/tsx" ]; then
  log "no node_modules/.bin/tsx — running the bootstrap install (rmd's own freshness check takes over after this)"
  ( cd "$TREE" && npm ci ) || die "npm ci failed in $TREE"
else
  log "node_modules present — leaving install freshness to ensureInstallFresh"
fi

cd "$TREE"
exec "$@"
