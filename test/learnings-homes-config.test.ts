import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  globalArtifactPath,
  globalLearningsHome,
  learningsHomes,
  userOverallLearningsHome,
  type Config,
} from "../src/lib/config.js";

// W1-T432: the org brain (learnings-user/, learnings-global/) used to derive
// ONLY from config.root, which is fine for one instance with one root. D-11's
// cell architecture gives each codebase its own config.root, which flips that
// same derivation into a silent splitter — N cells each grow a private, empty
// org brain instead of sharing one. `learningsHomes` (src/lib/config.ts) is
// the seam: an explicit config.learningsHomes override lets cells share by
// path, and the two-direction falsifier below proves both halves of the
// guarantee — sharing works, AND the unconfigured default is unchanged.

function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/cell-root", ...over };
}

// ── Direction 1 (the sharing direction): two Config fixtures with DIFFERENT
// roots but the SAME configured homes resolve IDENTICAL paths. ────────────
test("W1-T432: two cells with different config.root but the same configured learningsHomes resolve identical org-brain paths", () => {
  const sharedUserOverall = "/Users/shared/org-brain/learnings-user";
  const sharedGlobal = "/Users/shared/org-brain/learnings-global";

  const cellA = config({
    root: "/Users/shared/cells/cell-a",
    learningsHomes: { userOverall: sharedUserOverall, global: sharedGlobal },
  });
  const cellB = config({
    root: "/Users/shared/cells/cell-b",
    learningsHomes: { userOverall: sharedUserOverall, global: sharedGlobal },
  });

  assert.notEqual(cellA.root, cellB.root, "the two fixtures must actually have different roots");

  assert.equal(userOverallLearningsHome(cellA), sharedUserOverall);
  assert.equal(userOverallLearningsHome(cellB), sharedUserOverall);
  assert.equal(userOverallLearningsHome(cellA), userOverallLearningsHome(cellB));

  assert.equal(globalLearningsHome(cellA), sharedGlobal);
  assert.equal(globalLearningsHome(cellB), sharedGlobal);
  assert.equal(globalLearningsHome(cellA), globalLearningsHome(cellB));

  // globalArtifactPath derives from globalLearningsHome, so the sharing must
  // propagate through it too, not just the directory itself.
  assert.equal(globalArtifactPath(cellA), globalArtifactPath(cellB));
  assert.equal(globalArtifactPath(cellA), join(sharedGlobal, "artifact.yaml"));

  // learningsHomes itself (the named helper the consumers share) agrees.
  assert.deepEqual(learningsHomes(cellA), { userOverall: sharedUserOverall, global: sharedGlobal });
  assert.deepEqual(learningsHomes(cellB), { userOverall: sharedUserOverall, global: sharedGlobal });
});

// ── Direction 2 (the default direction): a fixture with NO homes configured
// resolves EXACTLY the pre-change config.root-derived paths — deleting the
// fallback fails this half. ────────────────────────────────────────────────
test("W1-T432: an unconfigured instance resolves today's config.root-derived learnings paths unchanged", () => {
  const unconfigured = config({ root: "/tmp/single-instance-root" });
  assert.equal(unconfigured.learningsHomes, undefined, "fixture must genuinely have no override set");

  assert.equal(userOverallLearningsHome(unconfigured), join("/tmp/single-instance-root", "learnings-user"));
  assert.equal(globalLearningsHome(unconfigured), join("/tmp/single-instance-root", "learnings-global"));
  assert.equal(
    globalArtifactPath(unconfigured),
    join("/tmp/single-instance-root", "learnings-global", "artifact.yaml"),
  );
  assert.deepEqual(learningsHomes(unconfigured), {
    userOverall: join("/tmp/single-instance-root", "learnings-user"),
    global: join("/tmp/single-instance-root", "learnings-global"),
  });
});

// A partial override (only one of the two homes configured) must default the
// OTHER home independently — proves the fallback is per-field, not all-or-nothing.
test("W1-T432: a partial learningsHomes override defaults the unconfigured half independently", () => {
  const sharedUserOverall = "/Users/shared/org-brain/learnings-user";
  const partial = config({
    root: "/tmp/cell-c",
    learningsHomes: { userOverall: sharedUserOverall },
  });

  assert.equal(userOverallLearningsHome(partial), sharedUserOverall);
  assert.equal(globalLearningsHome(partial), join("/tmp/cell-c", "learnings-global"));
});
