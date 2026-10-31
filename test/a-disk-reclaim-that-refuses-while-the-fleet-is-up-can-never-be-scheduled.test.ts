/**
 * W1-T2725 — the host reclaims disk only when an operator remembers to.
 *
 * `deploy/host-update.sh` already reclaims, and its own header says why that is not enough: the
 * disk fills "on a schedule nobody sets". But the script cannot BE scheduled — section 1 refuses
 * whenever a fleet container is running, which on a timer is always.
 *
 * ⚠ AND `rmd` CANNOT DO IT FROM INSIDE. Verified on this host 2026-09-02: the daemon container has
 * NO docker binary and NO /var/run/docker.sock. That is a deliberate posture, not an oversight, so
 * the schedule has to live on the host and this script is the only thing there that knows how.
 *
 * `--reclaim-only` is the schedulable SUBSET, and the subset boundary is the whole design:
 *   - `docker container prune` is NOT run. It removes STOPPED containers, and an ad-hoc worker that
 *     has exited is indistinguishable from junk from outside — exactly what section 1 protects.
 *   - `docker image prune -a` and `builder prune -a` ARE run. A running container references its own
 *     image, so neither can reach it. MEASURED on this host: that prune with all three fleet
 *     containers UP reclaimed 5.775GB and left all three running.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { registryShellFixture } from "#test/helpers/registry-shell-fixture.js";

const SCRIPT = readFileSync(join(REPO_ROOT, "deploy", "host-update.sh"), "utf8");

test("the fleet-up refusal still fires in the ordinary mode — the guard is carved out, not weakened", () => {
  assert.match(SCRIPT, /REFUSING — a fleet container is RUNNING/, "the refusal text survives");
  assert.match(
    SCRIPT,
    /elif \[ -n "\$\{LIVE\}" \]; then/,
    "the ordinary path still reaches that refusal through an elif, so only reclaim-only bypasses it",
  );
});

test("reclaim-only never runs `docker container prune` — the one command that can destroy work", () => {
  // This is the subset boundary. `container prune` removes STOPPED containers; the other two
  // cannot reach a running container's image. Guarding the wrong one would make the mode unsafe.
  assert.match(
    SCRIPT,
    /if \[ "\$\{RECLAIM_ONLY\}" -eq 0 \]; then\s*\n\s*docker container prune -f/,
    "container prune must sit behind a RECLAIM_ONLY=0 guard",
  );
  assert.match(SCRIPT, /--reclaim-only never removes a container/, "and the skip says so out loud");
});

test("reclaim-only skips the registry login, so an expired token cannot fail a disk reclaim", () => {
  // The login bounds the imageless window before a PULL. This mode pulls nothing, so depending on
  // a short-lived credential would make the schedule fail for a reason unrelated to disk.
  assert.match(
    SCRIPT,
    /if \[ "\$\{DRY_RUN\}" -eq 0 \] && \[ "\$\{RECLAIM_ONLY\}" -eq 0 \]; then/,
    "the az acr login block is guarded on RECLAIM_ONLY too",
  );
});

test("reclaim-only stops before the pull and the restart — a timer must never redeploy", t => {
  const script = join(REPO_ROOT, "deploy", "host-update.sh");
  for (const shadow of [false, true]) {
    const f = registryShellFixture(t);
    if (shadow) f.capture();
    const run = f.run(script, ["--reclaim-only",
      ...(shadow ? ["--selected-registry-shadow", f.session] : [])], { FIXTURE_RUNNING: "1" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /host-update: reclaim-only — no pull, no restart/);
    const docker = f.receipts().filter(c => c.bin === "docker");
    assert.ok(docker.some(c => c.args[0] === "image" && c.args[1] === "prune"), "reclaim actually ran");
    assert.ok(docker.some(c => c.args[0] === "builder" && c.args[1] === "prune"), "builder reclaim actually ran");
    assert.ok(!docker.some(c => ["pull", "start", "stop", "restart", "rm"].includes(c.args[0]!)),
      "reclaim-only must exit before pulling or changing any container lifecycle");
    assert.ok(docker.filter(c => c.args[0] === "run").every(c => c.args.some(a => a.endsWith(":/rmd-snapshot/state:ro"))),
      "any child is a read-only state snapshot, never a replacement container");
    if (shadow) assert.ok(f.rows().some(row => row.action === "host-update"), "shadow observations still run");
  }
  const control = registryShellFixture(t);
  const ordinary = control.run(script);
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
  assert.ok(control.receipts().some(c => c.bin === "docker" && c.args[0] === "pull"),
    "control: the same transport records a real ordinary-mode pull");
});

test("the flag is accepted and initialised, so an unknown-arg path cannot swallow it", () => {
  assert.match(SCRIPT, /^RECLAIM_ONLY=0$/m, "initialised before parsing");
  assert.match(SCRIPT, /--reclaim-only\) RECLAIM_ONLY=1; shift ;;/, "and parsed as a real flag");
});

test("the dry run tells the truth about what reclaim-only would skip", () => {
  // A dry run that lists commands the real run will not execute is worse than no dry run: it is
  // the printed-remedy-never-applied shape this repo already has a gate for.
  assert.match(SCRIPT, /docker container prune -f SKIPPED under --reclaim-only/);
  assert.match(SCRIPT, /no pull, no restart under --reclaim-only/);
});
