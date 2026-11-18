/**
 * MOVED: the approve-tree-on-a-shared-worktree-root suite now lives in
 * test/the-fleet-lanes-approve-runs-in-an-origin-main-tree.test.ts.
 *
 * That suite already imports src/run-task.ts, so its cases add no new importer to the affected-suite
 * reach ceiling (scripts/affected-reach-baseline.json is shrink-only). This file imports nothing from
 * src/ and holds no cases; it is safe to delete.
 */
export {};
