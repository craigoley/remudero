// W1-T13817 — a satellite PR that files a W1 id holds its reservation in core's refs/rmd-id/, where W1 ids are minted.
// The review read the subject's origin only, so remudero-ops#124 (W1-T13628, held in core by the PR's own branch)
// failed "id W1-T13628 is not reserved" on every fleet review. The holder is still judged against the PR's head.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { satelliteReservationRead, taskIdOwnershipFindingsAsync } from "#src/lib/review.js";
import { formatReservationAnchorMessage, readReservationAnchorsAsync, gitReservationRunnerAsync, type TaskIdDeclaration } from "#src/lib/task-id-reservation.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const HEAD = "landing-branch";

/** A bare origin and a working clone whose `origin` is it; `holds` maps an id to the branch its anchor names. */
function checkoutWithAnchors(t: TestContext, kind: string, holds: Record<string, string>): GitRepo {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const clone = gitRepo({ kind });
  t.after(() => { origin.cleanup(); clone.cleanup(); });
  clone.addRemote("origin", origin.dir);
  const tree = clone.git("rev-parse", "HEAD^{tree}");
  for (const [id, branch] of Object.entries(holds)) {
    const anchor = clone.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch, source: "automatic", startedAt: "2026-11-19T00:00:00.000Z" }));
    clone.git("push", "--quiet", "origin", `${anchor}:refs/rmd-id/${id}`);
  }
  return clone;
}

const declared = (...ids: string[]): TaskIdDeclaration[] => ids.map((id) => ({ id, file: `plan/tasks.d/${id}.yaml` }));

test("W1-T13817 criterion 1: a satellite review reads a W1 id its own origin lacks from core's origin, and passes a head that holds it", async (t) => {
  const satellite = checkoutWithAnchors(t, "rmd-satellite", {});
  const core = checkoutWithAnchors(t, "rmd-core", { "W1-T900301": HEAD });
  // Positive control: the subject-only read (every review before this fix) finds no reservation.
  const subjectOnly = await taskIdOwnershipFindingsAsync("", declared("W1-T900301"), [], HEAD, satellite.dir,
    (ids) => readReservationAnchorsAsync(ids, gitReservationRunnerAsync(satellite.dir)), async () => "[]");
  assert.deepEqual(subjectOnly.map((f) => f.kind), ["unreserved"]);
  const read = satelliteReservationRead(satellite.dir, core.dir);
  assert.equal((await read(["W1-T900301"])).get("W1-T900301")?.status, "present");
  const findings = await taskIdOwnershipFindingsAsync("", declared("W1-T900301"), [], HEAD, satellite.dir, read, async () => "[]");
  assert.deepEqual(findings, []);
});

test("W1-T13817 criterion 2: invariant:core-reservation-still-judged — a core id held by another branch is foreign, one in neither origin is unreserved, and a satellite's own prefix never reads core", async (t) => {
  const satellite = checkoutWithAnchors(t, "rmd-satellite", { "W1-T900304": HEAD });
  const core = checkoutWithAnchors(t, "rmd-core", { "W1-T900302": "someone-else", "OPS-T900305": HEAD, "W1-T900304": "someone-else" });
  const read = satelliteReservationRead(satellite.dir, core.dir);
  const findings = await taskIdOwnershipFindingsAsync("", declared("W1-T900302", "W1-T900303", "OPS-T900305", "W1-T900304"), [], HEAD, satellite.dir, read, async () => "[]");
  assert.deepEqual(findings.map((f) => [f.id, f.kind]), [["W1-T900302", "foreign"], ["W1-T900303", "unreserved"], ["OPS-T900305", "unreserved"]]);
  // The subject's own reservation stands; core is not consulted for it (W1-T900304 passes on the subject's holder).
  // A core origin that cannot be listed reads UNKNOWN, never absent.
  const broken = satelliteReservationRead(satellite.dir, "/nonexistent-rmd-core-checkout");
  assert.equal((await broken(["W1-T900303"])).get("W1-T900303")?.status, "unknown");
});
