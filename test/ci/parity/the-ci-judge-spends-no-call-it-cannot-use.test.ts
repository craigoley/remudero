import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CI_JUDGE_OFF_FILE,
  CI_JUDGE_REUSE_OFF_FILE,
  CI_JUDGE_VERDICTS_FILE,
  ciJudgeFloorKey,
  ciJudgeFullFloorStatus,
  ciJudgeStatusDescription,
  judgeCiEscalation,
  parseCiJudgeOutput,
  productionCiJudgePorts,
  readCiJudgeStatus,
  unionJudgeWithFloor,
  type CiJudgeFloor,
  type CiJudgePorts,
  type CiJudgePr,
} from "#src/lib/ci-escalation-judge.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The ci judge pays a model call only when the call can change what is posted. A full floor unions to
// a full run whatever the judge answers, and a new head whose diff carries the patch id of the PR's last
// judged diff, beside the same floor, gets that verdict again. The falsifier: drop the skip or the reuse
// and the judge port is called on these heads.

const KNOWN = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
const NARROW: CiJudgeFloor = { suites: ["test/a.test.ts"], fullRun: false };
const FULL: CiJudgeFloor = { suites: [], fullRun: true };
const REPLY = '{"add":["test/c.test.ts"],"escalateFull":false,"reason":"c greps the change"}';

interface Harness {
  ports: CiJudgePorts;
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
  posted: Array<{ pr: number; sha: string; description: string }>;
  calls: { judge: number; patchId: number };
  set: (next: { prs?: CiJudgePr[]; floor?: CiJudgeFloor; patch?: () => Promise<string | undefined>; reply?: string }) => void;
}

function harness(stateDir: string, overrides: Partial<CiJudgePorts> = {}): Harness {
  const rows: Harness["rows"] = [];
  const posted: Harness["posted"] = [];
  const calls = { judge: 0, patchId: 0 };
  let prs: CiJudgePr[] = [{ number: 7, headSha: "sha-1" }];
  let floor = NARROW;
  let patch: () => Promise<string | undefined> = async () => "patch-p";
  let reply = REPLY;
  const ports: CiJudgePorts = {
    stateDir,
    openPrs: async () => prs,
    changedFiles: async () => ["src/lib/scoring.ts"],
    diff: async () => "+const LABEL = \"ready\";",
    suiteIds: () => KNOWN,
    floor: () => floor,
    judge: async () => { calls.judge++; return reply; },
    patchId: async () => { calls.patchId++; return patch(); },
    post: async (pr, description) => void posted.push({ pr: pr.number, sha: pr.headSha, description }),
    log: (step, extra = {}) => void rows.push({ step, extra }),
    ...overrides,
  };
  const set: Harness["set"] = (next) => {
    if (next.prs) prs = next.prs;
    if (next.floor) floor = next.floor;
    if (next.patch) patch = next.patch;
    if (next.reply) reply = next.reply;
  };
  return { ports, rows, posted, calls, set };
}

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ci-judge-reuse-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("ci judge: a full floor posts the union's full-run status and the judge port is never called", async (t) => {
  // The union of a full floor with any verdict is a full run, so no reply can change the outcome.
  for (const reply of [REPLY, '{"add":[],"escalateFull":false,"reason":"r"}', '{"add":[],"escalateFull":true,"reason":"r"}', "garbage"]) {
    assert.equal(unionJudgeWithFloor(FULL, parseCiJudgeOutput(reply, KNOWN)).fullRun, true, reply);
  }
  // The old path, for the reply consistent with a full floor, posted exactly these bytes.
  const oldPath = parseCiJudgeOutput('{"add":[],"escalateFull":true,"reason":"the floor is already full"}', KNOWN);
  assert.equal(oldPath.kind, "parsed");
  const oldStatus = oldPath.kind === "parsed" ? ciJudgeStatusDescription(oldPath.output) : "";
  assert.equal(ciJudgeFullFloorStatus(FULL), oldStatus);
  assert.equal(ciJudgeFullFloorStatus(FULL), 'ci-judge {"add":[],"escalateFull":true}');
  // Read back on the CI side it is a full run beside any floor: it can only widen.
  for (const floor of [FULL, NARROW]) assert.equal(unionJudgeWithFloor(floor, readCiJudgeStatus(ciJudgeFullFloorStatus(FULL), KNOWN)).fullRun, true);

  const h = harness(tmp(t));
  h.set({ floor: FULL });
  const pass = await judgeCiEscalation(h.ports);
  assert.deepEqual([h.calls.judge, h.calls.patchId], [0, 0]);
  assert.deepEqual(pass, { off: false, judged: [], failed: [] });
  assert.deepEqual(h.posted, [{ pr: 7, sha: "sha-1", description: oldStatus }]);
  assert.deepEqual(h.rows.filter((row) => row.step === "ci_judge.skipped").map((row) => row.extra), [{ pr: 7, head_sha: "sha-1", reason: "floor already full" }]);
  // The head is recorded: the next pass spends nothing on it.
  await judgeCiEscalation(h.ports);
  assert.equal(h.posted.length, 1);
});

test("ci judge: a new head with the same patch id and floor reposts the prior verdict without a model call", async (t) => {
  const stateDir = tmp(t);
  const h = harness(stateDir);
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
  assert.equal(h.calls.judge, 1);
  const verdict = 'ci-judge {"add":["test/c.test.ts"],"escalateFull":false}';
  assert.deepEqual(h.posted, [{ pr: 7, sha: "sha-1", description: verdict }]);
  assert.equal(h.rows.find((row) => row.step === "ci_judge.judged")?.extra.patch_id, "patch-p");
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), "utf8")),
    { 7: { patchId: "patch-p", floorKey: ciJudgeFloorKey(NARROW), description: verdict } });

  // A rebase: a new head, the same diff. The verdict is posted on the new head and the model is not asked.
  h.set({ prs: [{ number: 7, headSha: "sha-2" }] });
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, []);
  assert.equal(h.calls.judge, 1);
  assert.deepEqual(h.posted.at(-1), { pr: 7, sha: "sha-2", description: verdict });
  assert.deepEqual(h.rows.filter((row) => row.step === "ci_judge.reused").map((row) => row.extra), [{ pr: 7, head_sha: "sha-2", patch_id: "patch-p" }]);
});

test("ci judge: a changed patch id, a changed floor or state/CI_JUDGE_REUSE_OFF each call the judge", async (t) => {
  const stateDir = tmp(t);
  const h = harness(stateDir);
  await judgeCiEscalation(h.ports);
  assert.equal(h.calls.judge, 1);

  h.set({ prs: [{ number: 7, headSha: "sha-2" }], patch: async () => "patch-q" });
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
  assert.equal(h.calls.judge, 2);

  // The same patch id beside a different floor is judged again: the verdict was read against the old floor.
  h.set({ prs: [{ number: 7, headSha: "sha-3" }], floor: { suites: ["test/a.test.ts", "test/b.test.ts"], fullRun: false } });
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
  assert.equal(h.calls.judge, 3);
  assert.notEqual(ciJudgeFloorKey(NARROW), ciJudgeFloorKey({ suites: ["test/a.test.ts", "test/b.test.ts"], fullRun: false }));
  assert.equal(ciJudgeFloorKey({ suites: ["test/b.test.ts", "test/a.test.ts"], fullRun: false }), ciJudgeFloorKey({ suites: ["test/a.test.ts", "test/b.test.ts"], fullRun: false }));

  // The rollback: with the reuse off, the same patch and floor are judged afresh and no patch id is read.
  writeFileSync(join(stateDir, CI_JUDGE_REUSE_OFF_FILE), "");
  const patchCalls = h.calls.patchId;
  h.set({ prs: [{ number: 7, headSha: "sha-4" }] });
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
  assert.equal(h.calls.judge, 4);
  assert.equal(h.calls.patchId, patchCalls);
  assert.equal(h.rows.filter((row) => row.step === "ci_judge.reused").length, 0);
  assert.equal(h.rows.at(-1)?.extra.patch_id, null);
});

test("ci judge: state/CI_JUDGE_OFF wins over the skip and the reuse — nothing is judged or posted", async (t) => {
  const stateDir = tmp(t);
  const h = harness(stateDir);
  await judgeCiEscalation(h.ports);
  writeFileSync(join(stateDir, CI_JUDGE_OFF_FILE), "");
  for (const floor of [FULL, NARROW]) {
    h.set({ prs: [{ number: 7, headSha: `sha-off-${String(floor.fullRun)}` }], floor });
    assert.deepEqual(await judgeCiEscalation(h.ports), { off: true, judged: [], failed: [] });
  }
  assert.deepEqual([h.calls.judge, h.calls.patchId, h.posted.length], [1, 1, 1]);
  assert.equal(h.rows.filter((row) => row.step === "ci_judge.skipped" || row.step === "ci_judge.reused").length, 0);
});

test("ci judge: a patch id that cannot be computed falls back to judging each head", async (t) => {
  for (const patch of [async () => undefined, async () => "", async (): Promise<string> => { throw new Error("git patch-id failed"); }]) {
    const stateDir = tmp(t);
    const h = harness(stateDir);
    h.set({ patch });
    await judgeCiEscalation(h.ports);
    await judgeCiEscalation(h.ports);
    assert.equal(h.calls.judge, 1, "the same head is still judged once");
    h.set({ prs: [{ number: 7, headSha: "sha-2" }] });
    assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
    assert.equal(h.calls.judge, 2, "a new head with no patch id is judged again");
    const judged = h.rows.filter((row) => row.step === "ci_judge.judged");
    assert.ok(judged.every((row) => row.extra.patch_id === null));
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), "utf8")), {});
  }
  const failing = harness(tmp(t));
  failing.set({ patch: async () => { throw new Error("git patch-id failed"); } });
  await judgeCiEscalation(failing.ports);
  assert.equal(failing.rows.find((row) => row.step === "ci_judge.judged")?.extra.patch_id_error, "git patch-id failed");

  // No patch-id port at all: today's head-sha keying, and no verdict is stored.
  const stateDir = tmp(t);
  const bare = harness(stateDir, { patchId: undefined });
  await judgeCiEscalation(bare.ports);
  bare.set({ prs: [{ number: 7, headSha: "sha-2" }] });
  await judgeCiEscalation(bare.ports);
  assert.equal(bare.calls.judge, 2);
});

test("ci judge: an unreadable verdicts file is named and judged afresh, a malformed reply stores nothing, a closed PR is pruned", async (t) => {
  for (const content of ["{broken", "[]"]) {
    const stateDir = tmp(t);
    writeFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), content);
    const h = harness(stateDir);
    assert.deepEqual((await judgeCiEscalation(h.ports)).judged, [7]);
    assert.ok(h.rows.some((row) => row.step === "ci_judge.verdicts_unreadable"), content);
  }
  const stateDir = tmp(t);
  writeFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), JSON.stringify({ 7: { patchId: "patch-p", floorKey: 1, description: "x" } }));
  const h = harness(stateDir);
  h.set({ reply: "no json here" });
  assert.deepEqual((await judgeCiEscalation(h.ports)).judged, []);
  assert.equal(h.calls.judge, 1, "an ill-typed stored verdict is not reused");
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), "utf8")), {});

  h.set({ prs: [{ number: 7, headSha: "sha-2" }], reply: REPLY });
  await judgeCiEscalation(h.ports);
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), "utf8")), "7"));
  h.set({ prs: [] });
  await judgeCiEscalation(h.ports);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, CI_JUDGE_VERDICTS_FILE), "utf8")), {});
  assert.ok(existsSync(join(stateDir, CI_JUDGE_VERDICTS_FILE)));
});

test("ci judge: the production patch id is git patch-id over the PR diff, blind to hunk line numbers", async () => {
  const ports = productionCiJudgePorts({ owner: "o", repo: "r", repoRoot: REPO_ROOT, stateDir: "/nonexistent", log: () => {} });
  const pr = { number: 5, headSha: "h5" };
  const diff = (at: number, body: string) => [
    "diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
    `@@ -${at},2 +${at},2 @@`, " const keep = 1;", "-const old = 2;", `+${body}`, "",
  ].join("\n");
  const id = await ports.patchId!(pr, diff(10, "const neu = 3;"));
  assert.match(id ?? "", /^[0-9a-f]{40}$/);
  // A merge of main shifts the hunk; the PR's own change is the same.
  assert.equal(await ports.patchId!(pr, diff(40, "const neu = 3;")), id);
  assert.notEqual(await ports.patchId!(pr, diff(10, "const neu = 4;")), id);
  // Whitespace is part of the change: --verbatim keeps it.
  assert.notEqual(await ports.patchId!(pr, diff(10, "const  neu = 3;")), id);
  assert.equal(await ports.patchId!(pr, ""), undefined);
  assert.equal(await ports.patchId!(pr, "not a diff at all\n"), undefined);
});
