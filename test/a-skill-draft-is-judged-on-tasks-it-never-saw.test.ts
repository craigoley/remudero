import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { GoldenCorpusItem } from "../src/lib/golden-corpus.js";
import type { HeldOutSelection } from "../src/lib/skill-eval.js";

// Phase 2 of 5 of the held-out skill eval (operator rulings 2026-10-13): the pure selector that picks
// the K merged tasks a skill draft is attempted on, its leak refusals, and the import boundary that
// keeps the drafter from ever seeing that set.

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Loaded inside each test, not at file load. On a tree without skill-eval.ts each proof then FAILS, which
 *  the reviewer's merge-base run records as discrimination; a file that cannot load reads as an unmeasured
 *  environment gap instead (`ProofCannotLoadError`, src/lib/review.ts). */
const skillEval = (): Promise<typeof import("../src/lib/skill-eval.js")> => import("../src/lib/skill-eval.js");

/** `type: null` builds an item with no dispatchable spec. */
function corpusItem(taskId: string, type: string | null = "implement"): GoldenCorpusItem {
  return {
    taskId,
    baseSha: `base-${taskId}`,
    headSha: `head-${taskId}`,
    mergedAt: "2026-10-01T00:00:00.000Z",
    creditSource: "ledger",
    proofs: [{ claim: `claim of ${taskId}`, proof: `unit test: the held-out proof title of ${taskId}`, holdout: false }],
    ...(type === null ? {} : { spec: { type, verify: "auto", files: [`src/lib/${taskId}.ts`] } }),
    freshness: { ageDays: 12 },
    heldOut: true,
  };
}

const TEN_IMPLEMENT = Array.from({ length: 10 }, (_, i) => corpusItem(`W1-T90${i}0`));
const DRAFT = { markdown: "# lint-first\n\n1. Run the type checker before the tests.\n", taskType: "implement" };
const ids = (r: HeldOutSelection): string[] => (r.ok ? r.items.map((i) => i.taskId) : []);

function refused(r: HeldOutSelection): Extract<HeldOutSelection, { ok: false }> {
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
  return r as Extract<HeldOutSelection, { ok: false }>;
}

test("the held-out draw is seeded by the draft's sha256: the same draft draws the same set, an edited draft a different one", async () => {
  const { SKILL_EVAL_HELD_OUT_TASKS, selectHeldOutTasks } = await skillEval();
  const first = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: DRAFT, excludedTaskIds: [] });
  const again = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: { ...DRAFT }, excludedTaskIds: [] });
  assert.ok(first.ok && again.ok);
  assert.equal(SKILL_EVAL_HELD_OUT_TASKS, 3);
  assert.equal(first.items.length, SKILL_EVAL_HELD_OUT_TASKS, "k defaults to the K = 3 ruling");
  assert.equal(first.draftSha256, sha256(DRAFT.markdown), "the draft is frozen by its own sha256 before the draw");
  assert.deepEqual(ids(again), ids(first));
  assert.equal(again.heldOutSetHash, first.heldOutSetHash);

  const edited = selectHeldOutTasks({
    corpus: TEN_IMPLEMENT, draft: { ...DRAFT, markdown: `${DRAFT.markdown}2. Then run the tests.\n` }, excludedTaskIds: [],
  });
  assert.ok(edited.ok);
  assert.notEqual(edited.draftSha256, first.draftSha256);
  assert.notDeepEqual([...ids(edited)].sort(), [...ids(first)].sort(), "an edited draft must draw a different held-out set");
  assert.notEqual(edited.heldOutSetHash, first.heldOutSetHash);
});

test("the held-out draw keeps only the draft's own task type and never draws a task the caller excluded", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const corpus = [
    corpusItem("W1-T9100"), corpusItem("W1-T9101"), corpusItem("W1-T9102"),
    corpusItem("W1-T9103"), corpusItem("W1-T9104"),
    corpusItem("W1-T9105", "recon"), corpusItem("W1-T9106", "diagnose"), corpusItem("W1-T9107", null),
  ];
  const r = selectHeldOutTasks({ corpus, draft: DRAFT, excludedTaskIds: new Set(["W1-T9101", "W1-T9103"]) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.eligibleCount, 3, "two excluded implement tasks and three other-type (or spec-less) items are not eligible");
  assert.deepEqual([...ids(r)].sort(), ["W1-T9100", "W1-T9102", "W1-T9104"]);
});

test("a draft quoting an eligible task's held-out proof is refused as proof-text-leak, naming the task", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const leaked = TEN_IMPLEMENT[4]!;
  const markdown = `${DRAFT.markdown}\nCheck: ${leaked.proofs[0]!.proof}\n`;
  const r = refused(selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: { ...DRAFT, markdown }, excludedTaskIds: [] }));
  assert.equal(r.reason, "proof-text-leak");
  assert.deepEqual(r.taskIds, [leaked.taskId]);
  assert.equal(r.draftSha256, sha256(markdown));

  const ownSupporting = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: { ...DRAFT, markdown }, excludedTaskIds: [leaked.taskId] });
  assert.ok(ownSupporting.ok, "a proof of a task the caller excluded (the draft's own evidence) is not a held-out leak");
});

test("a draft naming an eligible task id verbatim is refused as task-id-leak, but a longer id containing it is not", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const markdown = `${DRAFT.markdown}\nLearned from W1-T9020 and W1-T90601.\n`;
  const r = refused(selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: { ...DRAFT, markdown }, excludedTaskIds: [] }));
  assert.equal(r.reason, "task-id-leak");
  assert.deepEqual(r.taskIds, ["W1-T9020"], "W1-T90601 names a different task, so W1-T9060 is not leaked");

  const ownSupporting = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: { ...DRAFT, markdown }, excludedTaskIds: ["W1-T9020"] });
  assert.ok(ownSupporting.ok, "naming the draft's own excluded supporting task is not a held-out leak");
});

test("fewer eligible tasks than k is refused as too-few-eligible, never an empty or short success", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const corpus = [corpusItem("W1-T9200"), corpusItem("W1-T9201"), corpusItem("W1-T9202"), corpusItem("W1-T9203")];
  const r = refused(selectHeldOutTasks({ corpus, draft: DRAFT, excludedTaskIds: ["W1-T9202", "W1-T9203"] }));
  assert.equal(r.reason, "too-few-eligible");
  assert.equal(r.eligibleCount, 2);
  assert.deepEqual(r.taskIds, ["W1-T9200", "W1-T9201"]);
  assert.equal(refused(selectHeldOutTasks({ corpus: [], draft: DRAFT, excludedTaskIds: [] })).reason, "too-few-eligible");
});

test("a draw that returns an excluded task is refused as excluded-task-selected by the defensive overlap check", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const sneaky = TEN_IMPLEMENT[0]!;
  const r = refused(selectHeldOutTasks({
    corpus: TEN_IMPLEMENT, draft: DRAFT, excludedTaskIds: [sneaky.taskId],
    draw: (eligible) => [sneaky, ...eligible.slice(0, 2)],
  }));
  assert.equal(r.reason, "excluded-task-selected");
  assert.deepEqual(r.taskIds, [sneaky.taskId]);
});

test("a draft of a task type the sealed attempt cannot render is refused as type-not-attemptable", async () => {
  const { selectHeldOutTasks } = await skillEval();
  const corpus = [corpusItem("W1-T9300", "recon"), corpusItem("W1-T9301", "recon"), corpusItem("W1-T9302", "recon")];
  const r = refused(selectHeldOutTasks({ corpus, draft: { ...DRAFT, taskType: "recon" }, excludedTaskIds: [] }));
  assert.equal(r.reason, "type-not-attemptable");
});

test("a k that is not a positive integer is refused as invalid-k, never an empty success", async () => {
  const { selectHeldOutTasks } = await skillEval();
  for (const k of [0, -1, 1.5]) {
    assert.equal(refused(selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: DRAFT, excludedTaskIds: [], k })).reason, "invalid-k");
  }
  const one = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: DRAFT, excludedTaskIds: [], k: 1 });
  assert.equal(ids(one).length, 1);
});

test("heldOutSetHash is a sha256 of the sorted selected ids and is stable under corpus and exclusion order", async () => {
  const { heldOutSetHash, selectHeldOutTasks } = await skillEval();
  const excluded = ["W1-T9010", "W1-T9070"];
  const forward = selectHeldOutTasks({ corpus: TEN_IMPLEMENT, draft: DRAFT, excludedTaskIds: excluded });
  const shuffled = [...TEN_IMPLEMENT.slice(5), ...TEN_IMPLEMENT.slice(0, 5)].reverse();
  const backward = selectHeldOutTasks({ corpus: shuffled, draft: DRAFT, excludedTaskIds: [...excluded].reverse() });
  assert.ok(forward.ok && backward.ok);
  assert.deepEqual(ids(backward), ids(forward), "the draw ranks by hash, not by input position");
  assert.equal(backward.heldOutSetHash, forward.heldOutSetHash);
  assert.equal(forward.heldOutSetHash, sha256([...ids(forward)].sort().join("\n")));
  assert.equal(heldOutSetHash(["b", "a"]), heldOutSetHash(["a", "b"]));
});

// ── The import boundary: the real dependency-cruiser binary over a planted fixture tree ─────────

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const depcruiseBin = join(repoRoot, "node_modules", ".bin", "depcruise");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

function depcruiseFixture(files: Record<string, string>): { status: number; output: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-skill-eval-boundary-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "src", "lib", name), body);
  try {
    const output = execFileSync(process.execPath, [depcruiseBin, "src", "--config", configPath], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const LEAVES = {
  "golden-corpus.ts": `export const corpus = 1;\n`,
  "skill-eval.ts": `import { corpus } from "./golden-corpus.js";\nexport const evalSet = corpus;\n`,
};

test("depcruise refuses the drafter importing the held-out set, citing drafter-never-sees-held-out-set", () => {
  const { status, output } = depcruiseFixture({
    ...LEAVES,
    "skill-workshop.ts": `import { corpus } from "./golden-corpus.js";\nexport const draft = corpus;\n`,
    "workflow-mining.ts": `import { evalSet } from "./skill-eval.js";\nexport const mined = evalSet;\n`,
  });
  assert.notEqual(status, 0, `expected a nonzero exit for a planted drafter import. output:\n${output}`);
  assert.match(output, /drafter-never-sees-held-out-set/);
  assert.match(output, /src\/lib\/skill-workshop\.ts.*src\/lib\/golden-corpus\.ts/);
  assert.match(output, /src\/lib\/workflow-mining\.ts.*src\/lib\/skill-eval\.ts/);
});

test("depcruise lets skill-eval.ts import golden-corpus.ts: the held-out boundary binds only the drafter", () => {
  const { status, output } = depcruiseFixture({
    ...LEAVES,
    "skill-workshop.ts": `export const draft = 1;\n`,
    "workflow-mining.ts": `export const mined = 1;\n`,
  });
  assert.equal(status, 0, `expected a clean exit. output:\n${output}`);
  assert.doesNotMatch(output, /drafter-never-sees-held-out-set/);
});
