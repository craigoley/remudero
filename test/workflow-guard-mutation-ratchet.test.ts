// test/workflow-guard-mutation-ratchet.test.ts — W1-T3703.
//
// scripts/workflow-guard-mutation-ratchet.mjs had NO merge-base split: every non-baselined
// UNCOVERED guard blamed the diff under test, even when the guard already sat UNCOVERED at the
// merge base and this diff never touched it. W1-T3701 removed the same shape from repo-layout's
// house-literal ceiling; this suite pins the fix here, reusing comment-load-ratchet's own
// caused-vs-inherited rule (`splitCoverageViolations`, design note i) rather than restating it.
//
// Every acceptance below drives `main`'s `io` seam or the pure split/prune functions directly —
// no real mutation run, no real git call — the same testability argument the sibling suite
// (test/a-ci-skip-guard-can-fire-unconditionally.test.ts) already makes for this file's `io` seam.
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error — this executable .mjs intentionally has no declaration output; the complete
// seam consumed by this TypeScript suite is declared immediately below rather than left as any.
import * as workflowGuard from "../scripts/workflow-guard-mutation-ratchet.mjs";

interface SkipGuard {
  key: string;
  job: string;
  line: number;
  text: string;
  form: "if" | "or";
}

interface GuardResult {
  covered: boolean;
  by: string | undefined;
}

const {
  main,
  splitCoverageViolations,
  pruneStaleBaselineGuards,
  inheritedGuardReason,
} = workflowGuard as {
  main(argv: string[], io: Record<string, unknown>): number;
  splitCoverageViolations(
    uncovered: SkipGuard[],
    baseGuardsByKey: Map<string, SkipGuard>,
    classifyAtBase: (g: SkipGuard) => GuardResult,
  ): { caused: SkipGuard[]; inherited: SkipGuard[] };
  pruneStaleBaselineGuards(
    guards: Record<string, { reason: string }>,
    liveKeys: Set<string>,
  ): Record<string, { reason: string }>;
  inheritedGuardReason(mergeBase: string): string;
};

const GUARD_A: SkipGuard = { key: "j#1: guard-a", job: "j", line: 5, text: "  if [ \"$A\" ]; then", form: "if" };
const GUARD_B: SkipGuard = { key: "j#2: guard-b", job: "j", line: 9, text: "  if [ \"$B\" ]; then", form: "if" };

// ── acceptance 1: an inherited violation is reported as such, not failed ───────────────────────

test("acceptance 1: a guard already UNCOVERED at the merge base is INHERITED, not blamed on this diff", () => {
  const baseGuardsByKey = new Map([[GUARD_A.key, GUARD_A]]);
  const out = splitCoverageViolations([GUARD_A], baseGuardsByKey, () => ({ covered: false, by: undefined }));
  assert.deepEqual(out.inherited, [GUARD_A], "already-uncovered-at-base must be inherited");
  assert.deepEqual(out.caused, [], "and never counted against the diff that did not add it");
});

test("acceptance 1 (main): main does not block on a violation the merge base already carried", () => {
  const written: string[] = [];
  const logs: string[] = [];
  const code = main([], {
    readCi: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    readBaseline: () => ({ guards: {} }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    // Every classification — head AND base — reports uncovered here, which is exactly the shape
    // of "still uncovered at the merge base": nothing distinguishes it today, and nothing did then.
    classify: () => ({ covered: false, by: undefined }),
    resolveMergeBase: () => "0".repeat(40),
    readCiAtBase: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    writeBaseline: (text: string) => void written.push(text),
    log: (m: string) => void logs.push(m),
    err: () => {},
  });
  assert.equal(code, 0, "an inherited violation must not fail the diff that did not add it");
  assert.ok(
    logs.some((l) => l.includes("inherited, not this diff's growth; the ledger is updated.")),
    "the log must carry the sibling's own inherited wording, so a reader who knows that phrase reads this one the same way",
  );
});

// ── acceptance 2: an inherited violation updates the baseline ──────────────────────────────────

test("acceptance 2: recordInheritedGrowth's sibling — the baseline is rewritten with a real reason, not a placeholder", () => {
  const reason = inheritedGuardReason("abc123def456");
  assert.match(reason, /already UNCOVERED at abc123def456/);
  assert.match(reason, /inherited, not this diff's growth; the ledger is updated\./);
  assert.doesNotMatch(reason, /RECORDED UNMEASURED/, "an auto-recorded inherited reason must not read as --seed's own placeholder");
});

test("acceptance 2 (main): main writes the baseline for an inherited violation, so the ledger maintains itself", () => {
  let written: string | undefined;
  const code = main([], {
    readCi: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    readBaseline: () => ({ guards: {} }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    classify: () => ({ covered: false, by: undefined }),
    resolveMergeBase: () => "1".repeat(40),
    readCiAtBase: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    writeBaseline: (text: string) => void (written = text),
    log: () => {},
    err: () => {},
  });
  assert.equal(code, 0);
  assert.ok(written, "the baseline must be written when a violation turns out to be inherited");
  const guards = (JSON.parse(written as string) as { guards: Record<string, { reason: string }> }).guards;
  assert.ok(Object.keys(guards).length === 1, `expected exactly one recorded guard, got ${JSON.stringify(guards)}`);
  const [reason] = Object.values(guards).map((g) => g.reason);
  assert.match(reason, /inherited, not this diff's growth; the ledger is updated\./);
});

// ── acceptance 3: a genuinely new guarded mutation is still refused ────────────────────────────

test("acceptance 3: a guard absent from the merge base is CAUSED, unconditionally — the guard's direction is unchanged", () => {
  const baseGuardsByKey = new Map<string, SkipGuard>(); // nothing at the base at all
  const out = splitCoverageViolations([GUARD_A], baseGuardsByKey, () =>
    assert.fail("a guard absent at the base must never reach classifyAtBase"),
  );
  assert.deepEqual(out.caused, [GUARD_A]);
  assert.deepEqual(out.inherited, []);
});

test("acceptance 3 (contrast): a guard present at the base but COVERED there is also CAUSED — this diff broke it", () => {
  const baseGuardsByKey = new Map([[GUARD_A.key, GUARD_A]]);
  const out = splitCoverageViolations([GUARD_A], baseGuardsByKey, () => ({ covered: true, by: "test/x.test.ts" }));
  assert.deepEqual(out.caused, [GUARD_A], "a guard covered at the base and uncovered now is this diff's own doing");
  assert.deepEqual(out.inherited, []);
});

test("acceptance 3 (main): a diff that adds a guarded mutation is still refused, and exits 1", () => {
  const errs: string[] = [];
  const code = main([], {
    readCi: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    readBaseline: () => ({ guards: {} }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    classify: () => ({ covered: false, by: undefined }),
    resolveMergeBase: () => "2".repeat(40),
    readCiAtBase: () => "jobs:\n  other:\n    steps: []\n", // the guard did not exist at the base at all
    writeBaseline: () => assert.fail("a caused violation must never be recorded"),
    log: () => {},
    err: (m: string) => void errs.push(m),
  });
  assert.equal(code, 1, "a newly-added uncovered guard must still block the diff");
  assert.ok(errs.some((e) => e.includes("BLOCKED") && e.includes("j#1")));
});

// ── acceptance 4: a stale baseline row is dropped when the ledger is rewritten ─────────────────

test("acceptance 4: pruneStaleBaselineGuards drops a row whose guard no longer exists, and keeps a live one", () => {
  const guards = {
    "j#1: guard-a": { reason: "still a real guard" },
    "j#9: long-gone": { reason: "ci.yml no longer has this guard at all" },
  };
  const out = pruneStaleBaselineGuards(guards, new Set(["j#1: guard-a"]));
  assert.deepEqual(out, { "j#1: guard-a": { reason: "still a real guard" } });
});

test("acceptance 4 (main): a stale baseline row does not survive an inherited-violation rewrite", () => {
  let written: string | undefined;
  const code = main([], {
    readCi: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    readBaseline: () => ({
      guards: { "j#9: long-gone": { reason: "ci.yml no longer has this guard at all" } },
    }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    classify: () => ({ covered: false, by: undefined }),
    resolveMergeBase: () => "3".repeat(40),
    readCiAtBase: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    writeBaseline: (text: string) => void (written = text),
    log: () => {},
    err: () => {},
  });
  assert.equal(code, 0);
  const guards = (JSON.parse(written as string) as { guards: Record<string, unknown> }).guards;
  assert.ok(!("j#9: long-gone" in guards), "a stale row must be dropped when the ledger is rewritten");
  assert.ok(
    'j#1: if [ "$A" ]; then' in guards,
    "and the live, newly-inherited guard must be recorded",
  );
});

test("acceptance 4 (--seed): a stale baseline row does not survive a --seed rewrite either", () => {
  let written: string | undefined;
  main(["--seed"], {
    readCi: () => "jobs:\n  j:\n    steps:\n      - run: |\n          if [ \"$A\" ]; then\n            exit 0\n          fi\n",
    readBaseline: () => ({
      guards: { "j#9: long-gone": { reason: "ci.yml no longer has this guard at all" } },
    }),
    suites: () => ["test/a.test.ts"],
    redCorpus: () => [],
    classify: () => ({ covered: false, by: undefined }),
    writeBaseline: (text: string) => void (written = text),
    log: () => {},
    err: () => {},
  });
  const guards = (JSON.parse(written as string) as { guards: Record<string, unknown> }).guards;
  assert.ok(!("j#9: long-gone" in guards), "--seed rewrites the ledger too, and must not keep a stale row either");
});

// ── ci.yml did not exist at the base: nothing to inherit ────────────────────────────────────────

test("a ci.yml the base never had at all yields no inherited guards — everything is CAUSED", () => {
  const out = splitCoverageViolations([GUARD_A, GUARD_B], new Map(), () =>
    assert.fail("an empty base map must never reach classifyAtBase"),
  );
  assert.deepEqual(out.caused, [GUARD_A, GUARD_B]);
  assert.deepEqual(out.inherited, []);
});
