// The author preflight's push judge and its TAP reader, kept free of the preflight's own imports so that a
// src/ module can call the one judge of a receipt without reaching the preflight script (which reaches
// src/run-task.ts and holds top-level await). scripts/preflight-author.mjs re-exports every name here.
import { isAbsolute, relative, sep } from 'node:path';

/** The stages a run must have run before it may push, in the order the gate runs them. */
export const PUSH_STAGES = ['census-precheck', 'static-preflight', 'affected-tests'];

/** W1-T13272 — the failing tests W1-T13215's attribution labelled also red at the base, as the reason and the row name them. */
export function preexistingReds(receipt) {
  const tests = receipt.failureAttribution?.tests;
  return Array.isArray(tests) ? tests.filter((test) => test.state === 'also-red').map((test) => ({ file: test.file, test: test.title })) : [];
}

/**
 * W1-T13272 — whether `failed`, a run's first failed step, is a test stage that is red ONLY on tests the base fails too.
 * The stage must have ended on its own summary (no signal, no spawn error, complete output, every suite reported,
 * nothing cancelled, a passing test) and the labels must account for every failing test: one per failure, each naming
 * its file, none only at the head, none unattributed, counts that agree, and the merge base the base run was cut at.
 */
function failedOnlyOnBaseReds(receipt, failed) {
  const { counts, tests, base } = receipt.failureAttribution ?? {}, summary = failed.testSummary, reds = preexistingReds(receipt);
  return receipt.verdict === 'failed' && ['affected-tests', 'affected-tests-subset'].includes(failed.name) && !failed.signal && !failed.error &&
    failed.diagnostics?.mayBeIncomplete === false && failed.judge?.given > 0 && failed.judge.reported === failed.judge.given &&
    summary?.pass > 0 && summary.fail > 0 && summary.cancelled === 0 && reds.length === summary.fail && tests.length === summary.fail &&
    reds.every((red) => typeof red.file === 'string' && red.file.length > 0) && counts?.failingAtHead === summary.fail &&
    counts.alsoFailingAtBase === summary.fail && counts.failingOnlyAtHead === 0 && counts.unattributed === 0 &&
    typeof base?.mergeBase === 'string' && base.mergeBase.length > 0;
}

/**
 * W1-T11914 — "may I push?", derived once from the stages the receipt already records; nothing is measured here.
 * OBSERVED 2026-11-09: 489 of 804 suites ran, 4,379 tests passed, 0 failed, census and static were green, and the
 * verdict was over-capacity (exit 3); a pipeline read the exit as a failure and retried for about two hours.
 * RULE: a passed run is eligible. An over-capacity run is eligible only when the census, the static gate and the
 * subset that fits all ran and were measured green with zero failing tests. A failed step, a stage that did not
 * run or was not measured, a refusal and a dry run are not, and the reason names the stage. This reads the
 * verdict and never sets it: the verdict, the exit code and every check are what they were.
 * W1-T13272 (operator ruling 2026-11-16) — a red that main's code has on this host is not the change's. A failed run
 * whose test stage is red only on such tests is judged as the same run with those tests green, and when that run is
 * eligible so is this one, with a reason naming each red and the merge base. INVARIANT
 * a-red-the-change-caused-still-refuses: a red only at the head, an unattributed red or no attribution keeps the
 * refusal below, word for word.
 */
export function authorPushEligibility(receipt) {
  const steps = receipt.steps ?? [];
  const oneLine = (reason) => String(reason).replace(/\s+/g, ' ').trim();
  const answer = (pushEligible, reason) => ({ pushEligible, pushEligibleReason: oneLine(reason).slice(0, 400) });
  const stage = (name) => steps.find((step) => step.name === name || (name === 'affected-tests' && step.name === 'affected-tests-subset'));
  const failed = steps.find((step) => step.ok !== true);
  if (failed && failedOnlyOnBaseReds(receipt, failed)) {
    const withoutThoseReds = authorPushEligibility({ ...receipt, failureAttribution: undefined,
      verdict: receipt.selection === 'over-capacity' ? 'over-capacity' : 'passed',
      steps: steps.map((step) => (step === failed ? { ...step, ok: true, testSummary: { ...step.testSummary, fail: 0 } } : step)) });
    // The list is never cut to the length other reasons are held to: the reason must name every red.
    if (withoutThoseReds.pushEligible) {
      return { pushEligible: true, pushEligibleReason: oneLine(`every failing test is also red at the merge base ${
        receipt.failureAttribution.base.mergeBase} on this host: ${preexistingReds(receipt).map((red) => `${red.file} :: ${red.test}`).join('; ')}`) };
    }
  }
  if (failed) {
    return answer(false, `${failed.name} failed${failed.testSummary?.fail ? `: ${failed.testSummary.fail} failing test(s)` : ''}${
      receipt.verdict === 'refused' ? `; refused: ${receipt.error ?? 'no cause recorded'}` : ''}`);
  }
  if (receipt.verdict === 'passed') return answer(true, `passed: every stage this run selected ran green (${steps.map((step) => step.name).join(', ')})`);
  const notRun = PUSH_STAGES.find((name) => !stage(name));
  if (receipt.verdict === 'refused') {
    return answer(false, `refused ${notRun ? `before ${notRun} ran` : 'at the receipt, after its stages ran'}: ${receipt.error ?? 'no cause recorded'}`);
  }
  if (receipt.verdict !== 'over-capacity') {
    return answer(false, notRun ? `${notRun} was not run (verdict ${receipt.verdict ?? 'running'})`
      : `verdict ${receipt.verdict ?? 'running'} is not a pushable outcome and names no stage`);
  }
  if (notRun) return answer(false, `${notRun} was not run: ${receipt.affectedTestsNotRunReason ?? receipt.error ?? 'no cause recorded'}`);
  const unmeasured = steps.find((step) => step.notMeasured);
  if (unmeasured) return answer(false, `${unmeasured.name} was not measured (${unmeasured.notMeasured}); an over-capacity run needs it green`);
  const tests = stage('affected-tests'), summary = tests.testSummary;
  if (!summary || !(summary.pass > 0)) return answer(false, `${tests.name} recorded no passing test summary`);
  if (summary.fail !== 0 || summary.cancelled !== 0) {
    return answer(false, `${tests.name}: ${summary.fail} failing and ${summary.cancelled} cancelled test(s)`);
  }
  const ran = receipt.tiered?.ran?.length ?? 0, selected = receipt.suites?.length ?? 0;
  return answer(true, `over-capacity with nothing red: census-precheck, static-preflight and ${tests.name} ran green (${summary.pass} test(s) passed, 0 failed, ${
    ran} of ${selected} suite(s)); ${Math.max(0, selected - ran)} suite(s) are left to the hosted checks`);
}

/**
 * W1-T13215 — the failing tests a TAP report names, each with the file its `location:` diagnostic points at (never the
 * lines around it: concurrent suites interleave). A leaf failure is kept; a suite's own "subtests failed" row is not,
 * its leaves are. A file that failed as a whole is one entry titled `(whole file)`. `file` is null when the location
 * is missing or outside `root`.
 */
export function failingTestsFromTap(output, root) {
  const lines = String(output ?? '').split('\n'), tests = [], stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^( *)# Subtest: (.*)$/.exec(lines[i]);
    if (header) { stack.splice(header[1].length / 4); stack.push(header[2]); continue; }
    const failed = /^( *)not ok [0-9]+ - (.*)$/.exec(lines[i]);
    if (!failed) continue;
    const block = {};
    for (let j = i + 1; j < lines.length && lines[j].startsWith(`${failed[1]}  `) && !/^\s*\.\.\.$/.test(lines[j]); j += 1) {
      const field = /^\s+(type|location|failureType): '?(.*?)'?$/.exec(lines[j]);
      if (field) block[field[1]] = field[2];
    }
    if (block.type === 'suite' && block.failureType === 'subtestsFailed') continue;
    const located = String(block.location ?? '').replace(/^file:\/\//, '').replace(/:[0-9]+:[0-9]+$/, '');
    const path = located && isAbsolute(located) ? relative(root, located).split(sep).join('/') : '';
    const file = path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) ? path : null;
    const fileLevel = file !== null && failed[2].replace(/\\/g, '/').endsWith(file);
    tests.push({ file, title: fileLevel ? '(whole file)' : [...stack.slice(0, failed[1].length / 4), failed[2]].join(' > '), fileLevel });
  }
  return tests;
}
