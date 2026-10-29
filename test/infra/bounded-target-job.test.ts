import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { clearKick, kickFilePath, pendingKicks, requestKick } from "#src/lib/fleet-control.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

/**
 * W1-T10799 marker contract. A daemonless target's request writes its repo-scoped marker under the CORE root, beside the
 * core daemon's own kicks, so the two must never share a file or clear each other. The routing, the bounded job, replay and
 * receipts are proved through ProductBuildService and a real daemon pass in test/infra/product-build.test.ts; this suite
 * imports only the marker primitives, so it adds no import reach to the hub modules.
 */
test("W1-T10799: a target marker under the core root never collides with the core daemon's own kick", (t) => {
  const core = ownedFixtureDir(t, "bounded-target-marker").dir;
  const origin = "product:prd_x/op_1";
  requestKick(core, "W9-T1", "console-run");
  requestKick(core, "W9-T1", origin, "wreckterra");
  assert.notEqual(kickFilePath(core, "W9-T1", "wreckterra"), kickFilePath(core, "W9-T1"), "a repo-scoped marker is its own file");
  assert.ok(existsSync(kickFilePath(core, "W9-T1", "wreckterra")) && existsSync(kickFilePath(core, "W9-T1")));
  const read = () => pendingKicks(core).map((kick) => [kick.repo ?? "", kick.taskId, kick.origin]).sort();
  assert.deepEqual(read(), [["", "W9-T1", "console-run"], ["wreckterra", "W9-T1", origin]], "both are read, each with its own origin");

  // The same request again is still one marker for that repository.
  requestKick(core, "W9-T1", origin, "wreckterra");
  assert.equal(pendingKicks(core).filter((kick) => kick.repo === "wreckterra").length, 1);

  // Clearing the core daemon's own kick leaves the target's, and the reverse.
  assert.equal(clearKick(core, "W9-T1"), true);
  assert.deepEqual(read(), [["wreckterra", "W9-T1", origin]]);
  requestKick(core, "W9-T1", "console-run");
  assert.equal(clearKick(core, "W9-T1", "wreckterra"), true);
  assert.deepEqual(read(), [["", "W9-T1", "console-run"]]);

  // A repository name that could escape the core root is refused before any write.
  assert.throws(() => requestKick(core, "W9-T1", origin, "../wreckterra"), /unsafe repo/);
  assert.deepEqual(read(), [["", "W9-T1", "console-run"]]);
});
