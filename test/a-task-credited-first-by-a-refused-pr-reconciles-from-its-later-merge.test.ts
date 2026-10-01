// W1-T5034 — `deriveStatus` returns the ledger's LAST `pr.opened` the moment it reads MERGED (rung (a)), so a task
// whose first credit row is a filing (W1-T3376, #5088) or a stacked-base merge (W1-T3763, #6019) is judged on THAT
// PR alone and never reconciles, while a main-reaching build sits on the board. The reconcile read now asks whether
// ANOTHER merged PR carrying the task's anchored trailer reached main as a build, and nothing else moves.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { buildCreditCandidates, creditCandidatesFromProjection, creditIsReconcilable } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef, StatusProjection } from "../src/lib/status.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T3376";
const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;

function projection(prNumber: number, taskId = TASK): StatusProjection {
  return { taskId, status: "merged", merged: true, source: "ledger", prNumber, prUrl: url(prNumber) };
}

function ref(n: number, over: Partial<PrRef> = {}): PrRef {
  return { number: n, url: url(n), state: "MERGED", headRefName: `run-${TASK}-1790025600000`, body: `Remudero-Task: ${TASK}\n`, ...over };
}

const FILING = "chore(plan): file the clock census (#5088)";
const BUILD = "fix(clock): ignore comment text in clock signature census (#6455)";
const BUILD_PATHS = ["scripts/clock-signature-census.mjs", "test/clock-signature-census.test.ts"];

/** One call over the pure builder: the row's own PR is #5088 (a filing) unless `own` says otherwise. */
function candidate(
  opts: { own?: number; subjects?: Array<[number, string]>; paths?: Array<[number, string[]]>; later?: PrRef[]; bodies?: Array<[number, string]> },
) {
  const own = opts.own ?? 5088;
  const [c] = creditCandidatesFromProjection(
    [projection(own)],
    new Map(opts.subjects ?? []),
    new Map(opts.bodies ?? []),
    new Map(opts.paths ?? []),
    () => opts.later ?? [],
  );
  return c!;
}

test("W1-T5034: a refused filing credited first does not hide a later merged implementation", () => {
  const first = candidate({ subjects: [[5088, FILING]], paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]]] });
  assert.equal(first.creditHasOtherBuildMerge, undefined, "precondition: without a later PR the filing is refused");
  assert.equal(creditIsReconcilable(first), false);

  const c = candidate({
    subjects: [[5088, FILING], [6455, BUILD]],
    paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]], [6455, BUILD_PATHS]],
    later: [ref(6455), ref(5088, { headRefName: "chore/file-w1-t3376-x" })],
  });
  assert.equal(c.creditHasOtherBuildMerge, true);
  assert.equal(creditIsReconcilable(c), true);
  assert.equal(c.prNumber, 5088, "the row still names the filing");
});

test("W1-T5034: a stacked-base merge credited first does not hide the main re-land", () => {
  const other = "W1-T3763";
  const later = [
    ref(6019, { headRefName: `plan/${other}-1789753690256`, body: `Remudero-Task: ${other}\n` }),
    ref(6020, { headRefName: `run-${other}-1789753690256`, body: `Remudero-Task: ${other}\n` }),
  ];
  const evidence = [new Map([[6020, "perf(status): reuse merged trailer lookup (#6020)"]]), new Map<number, string>(), new Map([[6020, ["src/lib/status.ts", "test/status.test.ts"]]])] as const;
  const [c] = creditCandidatesFromProjection([projection(6019, other)], ...evidence, () => later);
  assert.equal(c?.creditHasOtherBuildMerge, true);
  assert.equal(creditIsReconcilable(c!), true);
  // The same PRs offered to a task that does not own them never credit it.
  const [foreign] = creditCandidatesFromProjection([projection(6019, TASK)], ...evidence, () => later);
  assert.equal(foreign?.creditHasOtherBuildMerge, undefined, "a PR owned by ANOTHER task never earns this one's credit");
});

test("W1-T5034: a filing-only credit is still refused", () => {
  const alone = candidate({ subjects: [[5088, FILING]], paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]]], later: [] });
  assert.equal(creditIsReconcilable(alone), false);
  assert.equal(alone.creditHasOtherBuildMerge, undefined);
  const otherFiling = candidate({
    subjects: [[5088, FILING], [5090, "chore(plan): refile (#5090)"]],
    paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]], [5090, ["plan/tasks.d/W1-T3376-x.yaml", "MASTER-PLAN.md"]]],
    later: [ref(5090, { headRefName: "chore/refile" })],
  });
  assert.equal(creditIsReconcilable(otherFiling), false, "a second filing is not a build either");
  const noSearch = creditCandidatesFromProjection([projection(5088)], new Map([[5088, FILING]]), new Map(), new Map([[5088, ["plan/tasks.d/x.yaml"]]]))[0]!;
  assert.equal(creditIsReconcilable(noSearch), false, "a caller passing no later-merge search keeps today's refusal");
});

test("W1-T5034: a stacked-base-only credit with no main commit is still refused", () => {
  const c = candidate({ own: 6019, later: [ref(6019, { headRefName: "plan/W1-T3376-1789753690256" })] });
  assert.equal(c.creditHasOtherBuildMerge, undefined);
  assert.equal(creditIsReconcilable(c), false);
  const second = candidate({ own: 6019, later: [ref(6019), ref(6021, { headRefName: "run-W1-T3376-1789753690300" })] });
  assert.equal(creditIsReconcilable(second), false, "a later PR with no main commit evidence is unknown, and unknown declines");
});

test("W1-T5034: an unmerged later PR never earns the credit", () => {
  for (const state of ["OPEN", "CLOSED"]) {
    const c = candidate({
      subjects: [[6455, BUILD]],
      paths: [[6455, BUILD_PATHS]],
      later: [ref(6455, { state })],
    });
    assert.equal(creditIsReconcilable(c), false, `${state} is not a merge`);
  }
  const merged = candidate({ subjects: [[6455, BUILD]], paths: [[6455, BUILD_PATHS]], later: [ref(6455)] });
  assert.equal(creditIsReconcilable(merged), true, "control: the same PR merged does credit");
});

test("W1-T5034: a later merge with an unknown or empty path list never earns the credit", () => {
  const filingShaped = "chore: wip (#6455)";
  assert.equal(creditIsReconcilable(candidate({ subjects: [[6455, filingShaped]], later: [ref(6455)] })), false, "no path list");
  assert.equal(creditIsReconcilable(candidate({ subjects: [[6455, filingShaped]], paths: [[6455, []]], later: [ref(6455)] })), false, "empty path list");
  assert.equal(creditIsReconcilable(candidate({ later: [ref(6455)] })), false, "no subject and no paths");
  assert.equal(
    creditIsReconcilable(candidate({ subjects: [[6455, filingShaped]], paths: [[6455, ["src/a.ts"]]], later: [ref(6455)] })),
    true,
    "control: a readable code diff under the same subject does credit",
  );
});

test("W1-T5034: a prerequisite-only later merge is refused despite a code diff", () => {
  const body = `Remudero-Task: ${TASK}\nPrerequisite split for ${TASK}'s own PR.\n\nThis PR carries ONLY the instrument: scripts/x.mjs.\n`;
  const c = candidate({ subjects: [[6455, BUILD]], paths: [[6455, BUILD_PATHS]], later: [ref(6455, { body })] });
  assert.equal(creditIsReconcilable(c), false);
  const ordinary = candidate({ subjects: [[6455, BUILD]], paths: [[6455, BUILD_PATHS]], later: [ref(6455)] });
  assert.equal(creditIsReconcilable(ordinary), true, "control");
});

test("W1-T5034: a reconcilable first credit is not re-searched and the destructive fields are unchanged", () => {
  let searched = 0;
  const args = [new Map([[6455, BUILD]]), new Map<number, string>(), new Map([[6455, BUILD_PATHS]])] as const;
  const [plain] = creditCandidatesFromProjection([projection(6455)], ...args);
  const [withSearch] = creditCandidatesFromProjection([projection(6455)], ...args, () => (searched++, [ref(7000)]));
  assert.equal(searched, 0, "a reconcilable row never consults the later-merge search");
  assert.deepEqual(withSearch, plain);

  // And when the search DOES decide, the row's own implementation field, number and url are untouched.
  const row = candidate({
    subjects: [[5088, FILING], [6455, BUILD]],
    paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]], [6455, BUILD_PATHS]],
    later: [ref(6455)],
  });
  const bare = candidate({ subjects: [[5088, FILING], [6455, BUILD]], paths: [[5088, ["plan/tasks.d/W1-T3376-x.yaml"]], [6455, BUILD_PATHS]] });
  assert.equal(row.creditHasOtherBuildMerge, true);
  assert.equal(row.creditIsImplementation, bare.creditIsImplementation);
  assert.equal(row.creditHasBuildDiff, bare.creditHasBuildDiff);
  assert.equal(row.creditIsImplementation, false, "the supersession close still reads the filing");
  assert.equal(row.prNumber, 5088);
  assert.equal(row.prUrl, url(5088));
});

// ── THE REAL BUILDER: a real git log and real gateway rows ──────────────────────────────────────

function planOf(id: string): Plan {
  const t: Task = { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files: ["src/example.ts"] };
  return { tasks: [t], byId: new Map([[id, t]]) };
}

/** A main whose first-parent history holds each `[pr, subject, path]` as a squash commit. */
function mainWith(commits: Array<[number, string, string[]]>): string {
  const repo = gitRepo({ kind: "w1-t5034" });
  for (const [pr, subject, paths] of commits) {
    for (const p of paths) {
      const full = join(repo.dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, `${pr}\n`);
    }
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", `${subject.replace(/\s*\(#\d+\)$/, "")} (#${pr})`);
  }
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo.dir;
}

function gatewayOf(rows: PrRef[] | null | "absent", firstOpened: number): GitHub {
  const byUrl = new Map((rows === null || rows === "absent" ? [] : rows).map((r) => [r.url, r]));
  const gw = {
    mergedTrailerLookup: () => () => null,
    findMergedByTrailer: () => null,
    prByRef: (u: string) => byUrl.get(u) ?? { number: firstOpened, url: u, state: "MERGED", headRefName: `run-${TASK}-1`, body: "" },
    headRefName: (u: string) => byUrl.get(u)?.headRefName,
    prBody: (u: string) => byUrl.get(u)?.body,
    changedFiles: () => [],
  } as Record<string, unknown>;
  if (rows !== "absent") gw.listMergedHeadBranches = () => rows;
  return gw as unknown as GitHub;
}

function openedPrRows(prNumber: number): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5034-ledger-`));
  const file = join(dir, "ledger.ndjson");
  writeFileSync(file, JSON.stringify({ ts: "2026-09-01T00:00:00Z", step: "pr.opened", task_id: TASK, pr_url: url(prNumber) }) + "\n");
  return file;
}

test("W1-T5034: the real credit builder reconciles a task from a real git log and gateway rows", () => {
  const root = mainWith([
    [6455, BUILD, BUILD_PATHS],
    [5088, FILING, ["plan/tasks.d/W1-T3376-x.yaml"]],
  ]);
  const rows = [
    ref(6455),
    ref(5088, { headRefName: "chore/file-w1-t3376-x" }),
    ref(5100, { headRefName: "run-W1-T9999-1", body: `Remudero-Task: W1-T9999\nRemudero-Task: ${TASK}\n` }),
  ];
  const build = (rowsArg: PrRef[] | null | "absent", openedPr: number, evidenceRoot = root) =>
    buildCreditCandidates("craigoley", "remudero", planOf(TASK), openedPrRows(openedPr), undefined, gatewayOf(rowsArg, openedPr), () => evidenceRoot);

  const c = build(rows, 5088);
  assert.equal(c.length, 1);
  assert.equal(c[0]?.prNumber, 5088, "rung (a) credits the filing, as in production");
  assert.equal(c[0]?.creditIsImplementation, false);
  assert.equal(c[0]?.creditHasOtherBuildMerge, true);
  assert.equal(creditIsReconcilable(c[0]!), true);

  // The same board where the ledger's last PR is already the build: nothing to search, nothing set.
  const direct = build(rows, 6455);
  assert.equal(direct[0]?.creditHasOtherBuildMerge, undefined);
  assert.equal(creditIsReconcilable(direct[0]!), true);

  // A failed or absent merged listing yields no candidates: the refusal direction, never a credit.
  for (const none of [null, "absent"] as const) {
    const refused = build(none, 5088);
    assert.equal(refused[0]?.creditHasOtherBuildMerge, undefined, `listing ${none}`);
    assert.equal(creditIsReconcilable(refused[0]!), false);
  }

  // A stacked-base merge with no `(#N)` commit on main and no other PR stays refused.
  const stacked = build([ref(5088, { headRefName: "plan/W1-T3376-1789753690256" })], 5088, mainWith([[7000, "feat: unrelated", ["src/other.ts"]]]));
  assert.equal(stacked[0]?.creditHasOtherBuildMerge, undefined);
  assert.equal(creditIsReconcilable(stacked[0]!), false);
});
