// @source-text-subject: src/**/*.ts — the claim is a property of EVERY lane that arms a pull request or posts a
// remudero-review success, including lanes no single fixture drives. Each census below is derived from the code, so a
// new lane that skips the task hold fails here without anyone listing it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { attemptArm, realArmDeps, realArmDepsAsync, SYNC_ARM_TASK_HOLD } from "#src/lib/arm-auto-merge.js";
import { stripComments, trackedSourceFiles } from "#test/helpers/daemon-loop-walk.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ARM_MODULE = "src/lib/arm-auto-merge.ts";
const REVIEW_MODULE = "src/lib/review.ts";
const PR_URL = "https://github.com/acme/remudero/pull/910";

const source = (path: string): string => stripComments(readFileSync(join(REPO_ROOT, path), "utf8"));

/** Every top-level function in `text`, by name, with its body's character span. */
function functionSpans(text: string): Array<{ name: string; start: number; end: number }> {
  const heads = [...text.matchAll(/^(?:export )?(?:async )?function\*? ([A-Za-z0-9_]+)\s*[<(]/gm)];
  return heads.map((head, index) => ({ name: head[1]!, start: head.index!, end: heads[index + 1]?.index ?? text.length }));
}
const enclosing = (spans: ReturnType<typeof functionSpans>, at: number): string | undefined =>
  spans.find((span) => at >= span.start && at < span.end)?.name;

test("census: every arm effector in the arm module is reached only through attemptArmSteps, after the task hold", () => {
  const text = source(ARM_MODULE);
  const spans = functionSpans(text);
  const effectorHolders = new Set([...text.matchAll(/deps\.(?:armAuto|mergeDirect|enqueue)\b/g)]
    .map((match) => enclosing(spans, match.index!)).filter((name): name is string => name !== undefined));
  assert.ok(effectorHolders.has("attemptArmSteps"), "positive control: the census sees the arm's own effector call");
  // Walk callers upward. A holder that only WRAPS deps runs no effector of its own: withSubmittedMark, and the
  // W1-T14902 write fence withTaskHoldAtWrite (its own census below pins that it re-reads the hold at each write).
  const WRAPPERS = ["withSubmittedMark", "withTaskHoldAtWrite"];
  const callers = (name: string) => new Set([...text.matchAll(new RegExp(`\\b${name}\\(`, "g"))]
    .map((match) => enclosing(spans, match.index!)).filter((caller): caller is string => caller !== undefined && caller !== name));
  const roots = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    if (name === "attemptArmSteps" || WRAPPERS.includes(name)) { roots.add(name); return; }
    const up = callers(name);
    assert.ok(up.size > 0, `${name} runs an arm effector but no function in the module calls it`);
    for (const caller of up) walk(caller);
  };
  for (const holder of effectorHolders) walk(holder);
  assert.deepEqual([...roots].sort(), ["attemptArmSteps", ...WRAPPERS].filter((root) => roots.has(root)).sort());
  for (const wrapper of WRAPPERS) {
    assert.ok(!roots.has(wrapper) || callers(wrapper).size === 1 && callers(wrapper).has("attemptArmSteps"),
      `the ${wrapper} wrapper is applied only inside attemptArmSteps`);
  }
  // Inside attemptArmSteps, the task hold is read before any effector or effector-bearing step.
  const arm = spans.find((span) => span.name === "attemptArmSteps")!;
  const body = text.slice(arm.start, arm.end);
  const hold = body.indexOf("taskHoldRefusalSteps(");
  assert.ok(hold > 0, "attemptArmSteps reads the task hold");
  // The wrappers only wrap the effectors (they call none at wrap time), so they may run before the hold.
  for (const effect of [...effectorHolders].filter((name) => name !== "attemptArmSteps" && !WRAPPERS.includes(name))
    .map((name) => `${name}(`).concat("deps.armAuto(", "deps.mergeDirect(")) {
    const at = body.indexOf(effect);
    assert.ok(at < 0 || at > hold, `${effect} sits before the task hold in attemptArmSteps`);
  }
});

test("census: no module but the arm module calls an arm effector, and no production lane uses the synchronous default arm", () => {
  const files = trackedSourceFiles();
  assert.ok(files.length > 100 && files.includes(ARM_MODULE), "positive control: the census reads the source tree");
  const outside = files.filter((file) => file !== ARM_MODULE);
  const direct = outside.flatMap((file) => [...source(file).matchAll(/\.(?:armAuto|mergeDirect)\(/g)].map(() => file));
  assert.deepEqual(direct, [], "every arm write goes through attemptArm, which reads the task hold");
  // The sync entry points read the hold through realArmDeps' fail-closed reader; a production lane must not reach them.
  const SYNC_ENTRIES = /\b(armAutoMerge|armAutoMergeDetailed|armAutoMergeAtOpen|attemptArm|armIfVerdictPermits)\b(?!Async)/g;
  const uses = outside.flatMap((file) => {
    const text = source(file);
    return [...text.matchAll(SYNC_ENTRIES)].filter((match) => {
      const lineStart = text.lastIndexOf("\n", match.index!) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", match.index!));
      const before = text.slice(lineStart, match.index!);
      // An import or re-export specifier names the symbol without using it; so does prose inside a string literal.
      const specifier = /^\s*(?:import|export)\b/.test(line) || /^\s*[A-Za-z0-9_]+,\s*$/.test(line);
      const inString = ["\"", "'", "`"].some((quote) => before.split(quote).length % 2 === 0);
      return !specifier && !inString;
    }).map((match) => `${file}: ${text.slice(text.lastIndexOf("\n", match.index!) + 1, text.indexOf("\n", match.index!)).trim()}`);
  });
  assert.deepEqual(uses, [
    "src/run-task.ts: arm: (prUrl: string, taskId: string | undefined) => ArmOutcome | ArmAttemptResult = armAutoMergeDetailed,",
  ], "only armAndLogOutcome's default names a sync arm, and no lane leaves that default in place (below)");
  const runTask = source("src/run-task.ts");
  const syncWrapperCalls = [...runTask.matchAll(/\barmAndLogOutcome\(([^;]*?)\)\s*;/gs)].map((match) => match[1]!.split(",").map((part) => part.trim()));
  assert.ok(syncWrapperCalls.length >= 2, "positive control: the census sees armAndLogOutcome's callers");
  for (const args of syncWrapperCalls) {
    assert.ok(args[3] !== undefined && args[3] !== "undefined" && args[3] !== "", `an armAndLogOutcome call leaves the sync default arm: ${args.join(", ")}`);
  }
});

test("census: every remudero-review publication that can post success reads the task hold first", () => {
  const text = source(REVIEW_MODULE);
  const spans = functionSpans(text);
  const calls = [...text.matchAll(/publishReviewStatusLocked\(([^;]*?)\);/gs)];
  assert.ok(calls.length >= 4, "positive control: the census sees the publisher's callers");
  const terminalCapable = calls.filter((call) => !/state: "pending"/.test(call[1]!)).map((call) => ({ fn: enclosing(spans, call.index!), at: call.index! }));
  assert.ok(terminalCapable.every((call) => call.fn === "postReviewStatusGuarded"),
    `a publisher outside postReviewStatusGuarded can post a terminal state: ${JSON.stringify(terminalCapable)}`);
  const guarded = spans.find((span) => span.name === "postReviewStatusGuarded")!;
  const holdAt = text.indexOf("guardedTaskHold(", guarded.start);
  assert.ok(holdAt > guarded.start && holdAt < guarded.end, "postReviewStatusGuarded reads the task hold");
  for (const call of terminalCapable) {
    const line = text.slice(text.lastIndexOf("\n", call.at) + 1, text.indexOf("\n", call.at));
    // The freshness refusal returns early through the publisher, which refuses it; every other terminal post follows the hold.
    assert.ok(call.at > holdAt || /reviewerCodePublicationRefusal\(/.test(line), `a terminal post precedes the task hold: ${line.trim()}`);
  }
  // Outside this module, the only raw status writer is the recording wrapper handed to the guarded poster as `post`.
  const raw = trackedSourceFiles().filter((file) => file !== REVIEW_MODULE)
    .flatMap((file) => [...source(file).matchAll(/\bpostReviewStatus\(/g)].map(() => file));
  assert.deepEqual(raw, ["src/cli/commands/review.ts"], "a new raw remudero-review writer must route through postReviewStatusGuarded");
});

test("the synchronous real arm fails closed: its reader reads unread, and a real arm with no reader refuses", () => {
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const sync = realArmDeps();
    assert.equal(sync.taskHold, SYNC_ARM_TASK_HOLD, "THE CLAIM: production's synchronous arm carries the fail-closed reader");
    assert.notEqual(realArmDepsAsync().taskHold, SYNC_ARM_TASK_HOLD, "the awaited arm replaces it with the real reader");
    assert.equal(typeof realArmDepsAsync().taskHold, "function");
    const writes: string[] = [];
    const fakes = {
      armAuto: () => { writes.push("armAuto"); }, mergeDirect: () => { writes.push("mergeDirect"); }, isMerged: () => false,
      headSha: () => "abc", ledgerLines: () => [], shadowInstance: () => false, say: () => {},
    };
    const withStub = attemptArm(PR_URL, { ...sync, ...fakes } as never);
    assert.equal(withStub.outcome, "hold-refused");
    assert.match(withStub.error ?? "", /dispatch_hold is unreadable \(the synchronous arm has no task-hold reader/);
    const unwired = attemptArm(PR_URL, { ...sync, ...fakes, taskHold: undefined } as never);
    assert.equal(unwired.outcome, "hold-refused", "a real arm with no reader wired refuses instead of skipping the check");
    assert.deepEqual(writes, [], "no arm and no direct merge reached GitHub");
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
});

test("census: every task-hold lookup goes through the one PR task resolver, fed by a fresh read of the live PR", () => {
  // Round 8 (C1, C2): a lane that hands the hold reader an id of its own, or a body read earlier or from a cache, judges
  // a task the PR may no longer name. The one hold reader is reached only through readPullRequestNamedTaskHold.
  const files = trackedSourceFiles();
  const HOLD_MODULE = "src/lib/task-dispatch-hold.ts";
  const callsOf = (name: string) => files.flatMap((file) => {
    const text = source(file);
    const spans = functionSpans(text);
    return [...text.matchAll(new RegExp(`\\b${name}\\(`, "g"))]
      .map((match) => ({ file, fn: enclosing(spans, match.index!), at: match.index!, text }))
      .filter((call) => call.fn !== name);
  });
  const readerCalls = callsOf("readTaskDispatchHold");
  assert.ok(readerCalls.length >= 1, "positive control: the census sees the hold reader's callers");
  assert.deepEqual(readerCalls.map((call) => `${call.file}:${call.fn}`), [`${HOLD_MODULE}:readPullRequestNamedTaskHold`],
    "THE CLAIM: only the resolver-fed lookup calls the hold reader");
  const lookups = callsOf("readPullRequestNamedTaskHold").map((call) => `${call.file}:${call.fn}`).sort();
  assert.deepEqual(lookups, ["src/lib/arm-auto-merge.ts:readPullRequestTaskHold", "src/lib/review.ts:guardedTaskHold"],
    "the arm and the review publisher (and the fix lane, which posts through it) are its only callers");
  const review = source(REVIEW_MODULE);
  assert.match(review, /readPullRequestNamedTaskHold\(opts\.prUrl, \{ stateDir: dirname\(opts\.ledgerPath\) \}\)/,
    "the publisher names the PR, never a task id: the resolver reads which task it names");
  const hold = source(HOLD_MODULE);
  assert.match(hold, /freshPullRowRead: PullRowRead = \(path\) => ghJsonAsync\(\["api", path\], undefined, undefined, \{ fresh: true \}\)/,
    "the act-time read revalidates through the broker");
  for (const fn of ["resolvePullRequestTaskSubject", "readPullRequestNamedTaskHold"]) {
    assert.match(hold, new RegExp(`function ${fn}\\([^)]*read: PullRowRead = freshPullRowRead`), `${fn} defaults to the fresh read`);
  }
  assert.match(source(ARM_MODULE), /readBody: PullRowRead = freshPullRowRead/, "the arm's reader defaults to the fresh read");
  // Round 9 (C3): the subject is the review lane's OWN task-id rule, reused rather than restated.
  assert.match(hold, /const taskId = resolveReviewTaskId\(body, headRefName, planOnlyFiling\);/);
  assert.equal(callsOf("resolveReviewTaskId").filter((call) => call.file === HOLD_MODULE).length, 1);
  // Round 9 (C2): a fresh broker read never joins an upstream GET that already left.
  assert.match(source("src/lib/gh-read-broker.ts"), /!\(request\.fresh && inFlight\.job\.started\)/,
    "the broker declines to join a started job for a fresh caller");
  // The unread-hold publisher classifies the live PR through the same resolver.
  const unread = callsOf("resolvePullRequestTaskSubject").map((call) => `${call.file}:${call.fn}`).sort();
  assert.ok(unread.includes(`${HOLD_MODULE}:readPullRequestNamedTaskHold`));
  assert.match(source("src/cli/commands/review.ts"), /args\.resolveSubject \?\?\s*\(\(url: string\) => resolvePullRequestTaskSubject\(url, freshPullRowRead, \(\) => args\.planOnlyFiling === true\)\)\)\(args\.prUrl\)/,
    "the unread-hold publisher resolves the live PR's task before it posts");
});

test("census: every arm and merge write re-reads the task hold with nothing awaited between that read and the write", () => {
  const text = source(ARM_MODULE);
  const spans = functionSpans(text);
  const span = (name: string) => {
    const found = spans.find((candidate) => candidate.name === name);
    assert.ok(found, `positive control: the census finds ${name}`);
    return text.slice(found.start, found.end);
  };
  // Every write the arm makes is fenced, and the fence is the outermost wrapper attemptArmSteps applies first.
  const arm = span("attemptArmSteps");
  assert.match(arm, /^[^]*?\{\s*deps = withTaskHoldAtWrite\(withSubmittedMark\(deps\)\);/, "attemptArmSteps fences its deps first");
  const fence = span("withTaskHoldAtWrite");
  assert.match(fence, /armAuto: fence\(deps\.armAuto\), mergeDirect: fence\(deps\.mergeDirect\)/, "arm and direct merge are fenced");
  assert.match(fence, /enqueue: fence\(deps\.enqueue\)/, "the merge-queue enqueue is fenced");
  // Between the re-read and the write: no await, no yield, and no other call that could suspend.
  const read = fence.indexOf("reading = reader(prUrl);");
  const write = fence.indexOf("return write(prUrl, ...rest);");
  assert.ok(read > 0 && write > 0, "positive control: the fence reads the hold and calls the write");
  assert.doesNotMatch(fence, /\bawait\b|\byield\b/, "the fence awaits and yields nothing: the write follows its read in the same turn");
  assert.match(fence, /reading instanceof Promise \? reading\.then\(decide, \(e: unknown\) => decide\(unread\(e\)\)\) : decide\(reading\)/,
    "the write runs in the read's own continuation, and a failed read holds");
  // Every write site's refusal carries the reason the fence named to the ledgered row.
  const catches = [...text.matchAll(/if \((e\d*) instanceof OperatorMergeHoldWriteRefused\) return ([^;]+);/g)];
  assert.ok(catches.length >= 7, `positive control: the census sees every write site's catch (saw ${catches.length})`);
  for (const [, name, ret] of catches) assert.equal(ret, `holdRefusedAtWrite(${name})`, `a write-site catch drops the fence's reason: ${ret}`);
});
