import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { draftProposalBatch } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";

// fb-1784921980488-44b355 §4 (MPG first-instance ruling: opus -> Opus 5): the Architect-tier
// roles (retro, triage, the inbox-draft rung) resolve their spawn model through
// architectModel(config, mounts) = the mounts.yaml `architect:` row. This exercises the
// inbox-draft rung's execution path — draftProposalBatch reaches that model resolution before
// any real worktree/spawn — so a mounts-table edit governs the spawn (validated live by the
// next inbox-draft ledger line's model). Lives in its own file, off run-task.test.ts's
// occasionally-file-flaky W1-T240 registry tests, so its coverage lands deterministically.

test("draftProposalBatch: resolves the Architect model from the mounts.yaml `architect:` row, then fails before any real spawn — the inbox-draft rung is mount-governed", async () => {
  const shim = ghShim([{ when: "", exit: 1 }]); // every gh call fails fast, including a clone attempt
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const root = mkdtempSync(join(tmpdir(), "rmd-draft-"));
  mkdirSync(join(root, "tmp"), { recursive: true });
  try {
    // A non-empty batch reaches `architectModel(config, mountsTable)` (Architect model = the
    // mounts.yaml architect row, claude-opus-5), passes the Tier Invariant, then fails at the
    // clone/worktree BEFORE spawning any worker — proving the mount-governed resolution runs.
    await assert.rejects(
      draftProposalBatch(
        [{ id: "P1", summary: "s", evidenceAnchors: [] }] as never,
        { root, claudeBin: "/bin/true" } as Config,
        "o",
        "r",
        "RUN-DRAFT-1",
        () => {},
      ),
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
