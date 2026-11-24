import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unresolvedCitationReferents, worktreeCitationEvidence } from "#src/lib/triage.js";

// W1-T13390: a triage lane that files into the ops catalog reads the public view for the citation check, so a
// correct citation of an ops task read as unresolved and grilled. The evidence now spans both catalogs.

function catalog(root: string, id: string, dependsOn: string[] = []): void {
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    join(root, "plan", "tasks.yaml"),
    [`- id: ${id}`, '  title: "seed"', "  repo: remudero", `  depends_on: [${dependsOn.join(", ")}]`, "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
}

test("the triage citation check resolves a cited task id in both catalogs", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-t13390-"));
  try {
    const pub = join(base, "public");
    const ops = join(base, "ops");
    catalog(pub, "W1-T4");
    catalog(ops, "W1-T9", ["W1-T4"]); // an ops task depending on a public one the ops plan alone cannot see
    writeFileSync(join(ops, "plan", "ops-only.yaml"), "x: 1\n");

    const both = unresolvedCitationReferents("duplicates W1-T4 and W1-T9, see plan/ops-only.yaml", worktreeCitationEvidence(pub, ops));
    assert.deepEqual(both.unresolved, []);
    assert.deepEqual(both.resolved, ["W1-T4", "W1-T9", "plan/ops-only.yaml"]);

    const publicOnly = unresolvedCitationReferents("duplicates W1-T4 and W1-T9", worktreeCitationEvidence(pub));
    assert.deepEqual(publicOnly.unresolved, ["W1-T9"], "without the ops root an ops id stays unresolved");

    const missing = unresolvedCitationReferents("W1-T4 and W1-T77", worktreeCitationEvidence(pub, ops));
    assert.deepEqual(missing.unresolved, ["W1-T77"], "an id in neither catalog still fails the check");

    const ev = worktreeCitationEvidence(pub, ops);
    assert.equal(ev.pathExists("../../../../../../etc/passwd"), false, "a path escaping both roots never resolves");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
