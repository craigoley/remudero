import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// NAMESPACE imports: the new exports do not exist at the merge base, and a named import would fail the whole file at
// load, which the reviewer reads as "never ran" rather than as a red.
import * as declarations from "#src/lib/advance-declarations.js";
import * as judge from "#src/lib/deploy-judge.js";
import { daemonFreshnessReads } from "#src/run-task.js";
import { asyncGit, type ServiceFreshness } from "#src/lib/self-sync.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/**
 * MEASURED 2026-10-13/14 (core ledger, ~/Remudero-notes/restart-cause-2026-10-14/): 34 of 47 core boots were freshness
 * restarts and 27 of those were released by a full-weight "daemon self" advance. W1-T6273 gives src/run-task.ts full
 * weight as a whole file, so 53 of 53 run-task.ts commits scored 18, though only 12 touched daemonCommand. The rest
 * (approveCommand, the skill-eval and verify-human commands, the inbox drafter, the fix rung) restarted a busy daemon
 * within ~30 minutes each. Full weight now follows the declarations a commit touched.
 */

const FULL = judge.DEPLOY_RESTART_SCORE_THRESHOLD.value;
const MIN = 60_000;
const busyAt = (changes: judge.DeployWorthChange[], nowMs = 2 * MIN) =>
  judge.decideFreshnessRestart({ changes, busy: true, staleSinceMs: 0, nowMs, state: { total: 0, scoredShas: [] } });

test("entry-declarations: a run-task.ts change outside the daemon's declarations is the src floor and a busy daemon defers it", () => {
  // The shape of 60b856f27, "fix(approve): a ratification PR title is fitted to commitlint's header limit", 2026-10-14.
  const approve = { sha: "60b856f27", subject: "fix(approve): a ratification PR title is fitted", files: ["src/run-task.ts", "test/x.test.ts"],
    declarations: ["approveCommand", "import"] };
  assert.equal(judge.freshnessAdvanceWorth(approve).score, 1);
  const decision = busyAt([approve]);
  assert.equal(decision.action, "defer", decision.reason);
  // The age horizon still delivers it: staleness alone reaches the threshold at the horizon.
  assert.equal(busyAt([approve], 60 * MIN).action, "restart");
});

test("entry-declarations: a run-task.ts change in daemonCommand or a daemon hook keeps full weight", () => {
  for (const touched of [["daemonCommand"], ["buildRetroDaemonHooks"], ["createDaemonGatewayFactory"], ["approveCommand", "daemonCommand"]]) {
    const change = { sha: "a", subject: "feat: x", files: ["src/run-task.ts"], declarations: touched };
    assert.equal(judge.freshnessAdvanceWorth(change).score, FULL, touched.join(","));
  }
  // W1-T6273's own advance, #9927, touched daemonCommand: it still restarts a busy daemon at once.
  const w1T6259 = { sha: "683f762c0", subject: "perf(daemon): every daemon-side gateway reads changed files off the loop (W1-T6259)",
    files: ["src/run-task.ts"], declarations: ["drainCommand", "runTask", "daemonCommand", "memoiseGatewayByRepo", "import"] };
  assert.equal(busyAt([w1T6259]).restartTrigger, "change");
});

test("entry-declarations: an unread, empty or unnamed declaration list keeps full weight", () => {
  for (const touched of [undefined, [], ["approveCommand", declarations.UNNAMED_DECLARATION]]) {
    const change = { sha: "b", files: ["src/run-task.ts"], ...(touched ? { declarations: touched } : {}) };
    assert.equal(judge.freshnessAdvanceWorth(change).score, FULL, JSON.stringify(touched));
  }
  // Another daemon self path in the same commit keeps full weight whatever run-task.ts declarations it touched.
  assert.equal(judge.freshnessAdvanceWorth({ sha: "c", files: ["src/run-task.ts", "src/lib/sweep.ts"], declarations: ["runFixRung"] }).score, FULL);
  // So does a daemon-scoped commit.
  assert.equal(judge.freshnessAdvanceWorth({ sha: "d", subject: "fix(sweep): x", files: ["src/run-task.ts"], declarations: ["runFixRung"] }).score, FULL);
});

const ENTRY = [
  'import { one } from "./lib/one.js";',
  "",
  "export function approveCommand(rest: string[]): number {",
  "  return rest.length;",
  "}",
  "",
  "export async function daemonCommand(rest: string[]): Promise<number> {",
  "  const lanes = 3;",
  "  return lanes + rest.length;",
  "}",
  "",
  "const HELPER_LIMIT = 4;",
  "",
].join("\n");

function seedEntryModule() {
  const origin = gitRepo();
  mkdirSync(join(origin.dir, "src"), { recursive: true });
  writeFileSync(join(origin.dir, "src/run-task.ts"), ENTRY);
  origin.git("add", "src/run-task.ts");
  origin.git("commit", "-qm", "feat: entry");
  const commit = (subject: string, edit: (text: string) => string, extra?: string) => {
    const path = join(origin.dir, "src/run-task.ts");
    writeFileSync(path, edit(readFileSync(path, "utf8")));
    origin.git("add", "src/run-task.ts");
    if (extra) {
      writeFileSync(join(origin.dir, extra), "x\n");
      origin.git("add", extra);
    }
    origin.git("commit", "-qm", subject);
    return origin.git("rev-parse", "HEAD");
  };
  return { origin, commit };
}

test("entry-declarations: real git names each hunk's enclosing declaration and every header a hunk adds", async () => {
  const { origin, commit } = seedEntryModule();
  const base = origin.git("rev-parse", "HEAD");
  const approve = commit("fix(approve): x", (text) => text.replace("return rest.length;", "return rest.length + 1;"));
  const daemon = commit("feat: lanes", (text) => text.replace("const lanes = 3;", "const lanes = 4;"));
  const added = commit("feat: helper", (text) => `${text}export function inboxDraft(): number {\n  return HELPER_LIMIT;\n}\n`);
  const imported = commit("refactor: import", (text) => text.replace('import { one } from "./lib/one.js";', 'import { one, two } from "./lib/one.js";'));
  const text = await asyncGit(origin.dir)(["log", "--format=%x1e%H", "-U0", "--no-color", "--no-ext-diff", `${base}..HEAD`, "--", "src/run-task.ts"]);
  const touched = declarations.parseTouchedDeclarations(text);
  assert.deepEqual(touched.get(approve), ["approveCommand"]);
  assert.deepEqual(touched.get(daemon), ["daemonCommand"]);
  assert.deepEqual(touched.get(added), ["HELPER_LIMIT", "inboxDraft"]);
  assert.deepEqual(touched.get(imported), ["import"]);
  assert.equal(touched.size, 4);
  // A top-of-file hunk that is not a declaration or an import is unnamed, which keeps full weight.
  assert.deepEqual(declarations.parseTouchedDeclarations(`\x1e${approve}\n@@ -1 +1 @@\n-// header\n+// header two\n`).get(approve), [""]);
  assert.deepEqual(declarations.parseTouchedDeclarations(`\x1e${approve}\n@@ -0,0 +1 @@\n`).get(approve), [""]);
  // A commit with no hunk (a merge, a mode change) maps to an empty list, which keeps full weight.
  assert.deepEqual(declarations.parseTouchedDeclarations(`\x1e${approve}\n`).get(approve), []);
  assert.deepEqual(declarations.parseTouchedDeclarations("@@ -1 +1 @@ }\n").size, 0, "text before the first commit marker is ignored");
});

test("entry-declarations: the annotation reads git only for an entry-module advance and leaves the assessment on failure", async () => {
  const behind = (files: string[]): ServiceFreshness => ({ status: "assessed", dirty: false,
    behind: { oldSha: "o", newSha: "n", changedPaths: files, changes: [{ sha: "n", subject: "feat: x", files }, { sha: "m", files: ["src/lib/inbox.ts"] }] } });
  const calls: string[][] = [];
  const answer = (out: string) => async (args: string[]) => { calls.push(args); return out; };
  const other = behind(["src/lib/inbox.ts"]);
  assert.equal(await declarations.withTouchedDeclarations(other, answer("")), other);
  const degraded: ServiceFreshness = { status: "degraded", reason: "x" };
  assert.equal(await declarations.withTouchedDeclarations(degraded, answer("")), degraded);
  assert.equal(calls.length, 0, "no entry-module commit: no git read");
  const entry = behind(["src/run-task.ts"]);
  const annotated = await declarations.withTouchedDeclarations(entry, answer("\x1en\n@@ -3 +3 @@ export function approveCommand(rest: string[]): number {\n"));
  assert.deepEqual(calls, [["log", "--format=%x1e%H", "-U0", "--no-color", "--no-ext-diff", "o..n", "--", "src/run-task.ts"]]);
  assert.ok(annotated.status === "assessed" && annotated.behind?.changes);
  assert.deepEqual(annotated.behind.changes, [
    { sha: "n", subject: "feat: x", files: ["src/run-task.ts"], declarations: ["approveCommand"] },
    { sha: "m", files: ["src/lib/inbox.ts"] },
  ]);
  const failed = await declarations.withTouchedDeclarations(entry, async () => { throw new Error("log unreadable"); });
  assert.equal(failed, entry, "an unreadable log leaves the commits unannotated, which keeps full weight");
});

test("entry-declarations: the daemon's freshness read defers a non-daemon run-task.ts advance and restarts for daemonCommand", async () => {
  const { origin, commit } = seedEntryModule();
  const clone = gitRepo({ cloneFrom: origin.dir });
  commit("fix(approve): x", (text) => text.replace("return rest.length;", "return rest.length + 1;"), "README.md");
  const { checkFreshness } = daemonFreshnessReads(clone.dir, {}, { ignoreReentrancyGuard: true });
  const first = await checkFreshness();
  assert.ok(first.stale, JSON.stringify(first));
  assert.deepEqual(first.changes?.map((change) => (change as judge.DeployWorthChange).declarations), [["approveCommand"]]);
  assert.equal(busyAt([...first.changes!]).action, "defer");
  commit("feat: lanes", (text) => text.replace("const lanes = 3;", "const lanes = 4;"));
  const second = await checkFreshness();
  assert.ok(second.stale);
  assert.equal(busyAt([...second.changes!]).restartTrigger, "change");
});
