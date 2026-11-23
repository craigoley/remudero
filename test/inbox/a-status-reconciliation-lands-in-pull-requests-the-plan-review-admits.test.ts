import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  landingIdentity,
  landPlanReconcileShards,
  landPlanReconcileShardsAsync,
  PLAN_REVIEW_RECORDS_PER_PULL_REQUEST,
  type LandContentInput,
  type LandFeedbackResult,
  type LandingRepository,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T14452. OBSERVED 2026-11-23: the cadence's status reconciliation opened remudero-ops #427 with 72
// records and ops-gate refused it on the plan review's size rule. Each test lands against a real bare
// origin; only `gh` and the PR preflight are faked.

/** Copied from remudero-ops scripts/ops-gate.rb (line 71 on 2026-11-23), kept here as text, never read across repos. */
const OPS_GATE_SIZE_RULE_LINE = "  MAX_RECORDS_PER_PULL_REQUEST = 50";

const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t14452-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const ok = () => ({ ok: true, failures: [], unreadable: [] });

const pathOf = (n: number): string => `plan/tasks.d/W1-T${n}-fixture.yaml`;
const queued = (n: number): string => `- id: W1-T${n}\n  title: W1-T${n} fixture\n  status: queued\n`;
const merged = (n: number): string => queued(n).replace("  status: queued\n", "  status: merged\n");

interface Origin {
  origin: GitRepo;
  root: GitRepo;
  calls: string[][];
  gh: (args: string[]) => string;
  cleanup(): void;
}

/** A bare origin whose main holds `count` queued shards, and the checkout the landing runs from. */
function seededOrigin(kind: string, count: number): Origin {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  for (let n = 1; n <= count; n++) {
    const abs = join(seed.dir, pathOf(n));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, queued(n));
  }
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed queued shards");
  seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const root = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-root` });
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/14452\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return {
    origin,
    root,
    calls,
    gh,
    cleanup() {
      root.cleanup();
      seed.cleanup();
      origin.cleanup();
    },
  };
}

/** The paths the landing branch changes against main: what the plan review would count as records. */
function changedOnBranch(origin: GitRepo): string[] {
  return origin.git("diff", "--name-only", "main", BRANCH).split("\n").filter(Boolean).sort();
}

function inputsFor(numbers: readonly number[]): LandContentInput[] {
  return numbers.map((n) => ({ relPath: pathOf(n), content: merged(n) }));
}

function createArgs(calls: readonly string[][]): string[] {
  const create = calls.find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(create, "the landing must open a pull request");
  return create;
}

test("W1-T14452 criterion 1: a reconciliation over the bound lands exactly the bound's worth, in input order, and reports the rest as not landed", async () => {
  const limit = PLAN_REVIEW_RECORDS_PER_PULL_REQUEST;
  const total = limit + 22; // #427 carried 72 records
  // Descending, so "the first in input order" differs from both path order and task-number order.
  const numbers = Array.from({ length: total }, (_, i) => total - i);
  const inputs = inputsFor(numbers);
  const kept = inputs.slice(0, limit).map((i) => i.relPath);
  const rest = inputs.slice(limit).map((i) => i.relPath);

  const world = seededOrigin("w1-t14452-over-async", total);
  try {
    const result: LandFeedbackResult = await withLiveWritesAllowed(() =>
      landPlanReconcileShardsAsync(world.root.dir, inputs, {
        gh: world.gh,
        planPrPreflight: ok,
        targetRepository: TARGET,
        landingOwner: OWNER,
      }),
    );
    assert.equal(result.landed, true, result.error);
    assert.equal(result.error, undefined);
    assert.deepEqual([...result.files].sort(), [...kept].sort(), "this call lands the first bound's worth of inputs");
    assert.deepEqual(result.notLanded, rest, "the rest are reported as not landed, in input order");
    const changed = changedOnBranch(world.origin);
    assert.equal(changed.length, limit, `the landing branch changes ${changed.length} records; the plan review admits ${limit}`);
    assert.deepEqual(changed, [...kept].sort());
    for (const relPath of rest) {
      assert.equal(world.origin.git("show", `${BRANCH}:${relPath}`) + "\n", queued(Number(/W1-T(\d+)/.exec(relPath)![1])), `${relPath} is left as main has it`);
    }
    const create = createArgs(world.calls);
    const body = create[create.indexOf("--body") + 1];
    for (const relPath of rest) assert.ok(!body.includes(relPath), `the PR body must not claim ${relPath}`);
    for (const relPath of kept) assert.ok(body.includes(relPath), `the PR body lists ${relPath}`);
  } finally {
    world.cleanup();
  }

  // The sync lander takes the same bound.
  const sync = seededOrigin("w1-t14452-over-sync", total);
  try {
    const result = withLiveWritesAllowed(() =>
      landPlanReconcileShards(sync.root.dir, inputs, { gh: sync.gh, planPrPreflight: ok, targetRepository: TARGET, landingOwner: OWNER }),
    );
    assert.equal(result.landed, true, result.error);
    assert.deepEqual([...result.files].sort(), [...kept].sort());
    assert.deepEqual(result.notLanded, rest);
    assert.deepEqual(changedOnBranch(sync.origin), [...kept].sort());
  } finally {
    sync.cleanup();
  }
});

test("W1-T14452 criterion 2: the bound is one exported constant equal to ops-gate.rb's MAX_RECORDS_PER_PULL_REQUEST", () => {
  const match = /^\s*MAX_RECORDS_PER_PULL_REQUEST\s*=\s*(\d+)\s*$/.exec(OPS_GATE_SIZE_RULE_LINE);
  assert.ok(match, "the copied ops-gate.rb line must still carry the constant");
  const gateValue = Number(match[1]);
  assert.equal(PLAN_REVIEW_RECORDS_PER_PULL_REQUEST, gateValue, "the bound equals the plan review's per-pull-request record limit");
});

test("W1-T14452 criterion 3: a reconciliation at or under the bound lands exactly as before, byte for byte", async () => {
  const limit = PLAN_REVIEW_RECORDS_PER_PULL_REQUEST;
  for (const count of [3, limit]) {
    const numbers = Array.from({ length: count }, (_, i) => count - i);
    const inputs = inputsFor(numbers);
    const world = seededOrigin(`w1-t14452-at-${count}`, count);
    try {
      const result = await withLiveWritesAllowed(() =>
        landPlanReconcileShardsAsync(world.root.dir, inputs, {
          gh: world.gh,
          planPrPreflight: ok,
          targetRepository: TARGET,
          landingOwner: OWNER,
        }),
      );
      assert.equal(result.landed, true, result.error);
      assert.ok(!("notLanded" in result), `a ${count}-input landing reports nothing as not landed`);
      assert.deepEqual([...result.files].sort(), inputs.map((i) => i.relPath).sort(), `all ${count} inputs land`);
      // The pushed tree is main's tree with every input's bytes in place, and nothing else.
      const expected = gitRepo({ cloneFrom: world.origin.dir, kind: `w1-t14452-expect-${count}` });
      try {
        for (const input of inputs) writeFileSync(join(expected.dir, input.relPath), input.content);
        expected.git("add", "-A");
        assert.equal(world.origin.git("rev-parse", `${BRANCH}^{tree}`), expected.git("write-tree"), "the landed tree is byte for byte the whole reconciliation");
      } finally {
        expected.cleanup();
      }
      const message = world.origin.git("log", "-1", "--format=%B", BRANCH);
      for (const input of inputs) assert.ok(message.includes(`- ${input.relPath}`), `the commit lists ${input.relPath}`);
      const create = createArgs(world.calls);
      const body = create[create.indexOf("--body") + 1];
      assert.equal(body.split("\n").filter((line) => line.startsWith("- plan/tasks.d/")).length, count, "one Acceptance bullet per input");
    } finally {
      world.cleanup();
    }
  }
});
