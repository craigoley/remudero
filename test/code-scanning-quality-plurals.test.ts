import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — the trusted metadata classifier is a plain ESM module.
import {classifyCodeScanningMergePolicy as classify} from '../src/lib/code-scanning-merge-policy.mjs';

const head = 'a'.repeat(40);
const link = '[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A12411+tool%3ACodeQL+is%3Aopen).';
function fixture(rows = ' * 2 warnings\n * 1 note\n', total = 3) {
  return {prNumber:12411, headSha:head, observedHeadSha:head, filesComplete:true, filesHeadSha:head,
    changedFileCount:1, files:[{filename:'src/feature.ts'}], checksComplete:true, checksHeadSha:head,
    checks:[{id:117200618031, name:'CodeQL', head_sha:head, status:'completed', conclusion:'success',
      app:{id:57789, slug:'github-advanced-security', owner:{login:'github'}},
      output:{title:`${total} new alert${total === 1 ? '' : 's'}`,
        summary:'### New alerts in code changed by this pull request\n\n' + rows + '\nSee annotations below for details.\n\n' + link}}]};
}
type Input = ReturnType<typeof fixture>;

test('observed CodeQL quality plurals remain below the unchanged security threshold', () => {
  // The mixed quality rows are the real headerless shape observed on PR #12411.
  assert.deepEqual(classify(fixture()), {state:'safe', mergeAllowed:true, reason:'trusted-complete-exact-head-below-security-threshold'});
  for (const level of ['error', 'warning', 'note']) for (const conclusion of ['success', 'failure']) {
    for (const suffix of ['', 's']) {
      const x = fixture(` * 2 ${level}${suffix}\n`, 2);
      x.checks[0]!.conclusion = conclusion;
      assert.equal(classify(x).state, 'safe', `${conclusion}: ${level}${suffix}`);
    }
  }
});

test('plural quality rows preserve exact totals trusted identity and complete evidence', () => {
  assert.equal(classify(fixture()).mergeAllowed, true, 'the actual supported plural shape is the positive control');
  const mutations: Array<(x: Input) => void> = [
    x => { x.checks[0]!.output.title = '4 new alerts'; },
    x => { x.checks[0]!.output.summary = x.checks[0]!.output.summary.replace('2 warnings', '1 warnings'); x.checks[0]!.output.title = '2 new alerts'; },
    x => { x.checks[0]!.output.summary = x.checks[0]!.output.summary.replace(' * 2 warnings\n', ' * 2 warnings\n * 1 warning\n'); x.checks[0]!.output.title = '4 new alerts'; },
    x => { x.prNumber = 99; },
    x => { x.observedHeadSha = 'b'.repeat(40); },
    x => { x.checks[0]!.head_sha = 'b'.repeat(40); },
    x => { x.checks[0]!.app.id = 1; },
    x => { x.checks[0]!.app.slug = 'forged'; },
    x => { x.checks[0]!.app.owner.login = 'attacker'; },
    x => { x.filesComplete = false; },
    x => { x.changedFileCount = 2; },
    x => { x.checksComplete = false; },
    x => { x.checksHeadSha = 'b'.repeat(40); },
    x => { x.checks[0]!.status = 'in_progress'; },
    x => { x.checks[0]!.conclusion = 'neutral'; },
    x => { x.checks.push({...x.checks[0]!}); },
    x => { x.checks.push({...x.checks[0]!, id:x.checks[0]!.id + 1, status:'in_progress'}); },
    x => { x.files[0]!.filename = '../docs/hidden.md'; },
  ];
  for (const mutate of mutations) {
    const x = fixture(); mutate(x);
    assert.equal(classify(x).mergeAllowed, false, String(mutate));
  }
});

test('plural quality parsing never admits high critical or unknown alert rows', () => {
  assert.equal(classify(fixture()).mergeAllowed, true, 'real quality support must exist before the negative controls');
  for (const level of ['high', 'critical', 'highs', 'criticals', 'medium', 'future-level']) {
    const result = classify(fixture(` * 2 ${level}\n * 1 note\n`));
    assert.equal(result.mergeAllowed, false, level);
    if (level === 'high' || level === 'critical') assert.equal(result.state, 'blocked', level);
  }
  for (const row of ['0 warnings', '-2 warnings', '2.5 warnings', '2 warnings extra', '9007199254740993 warnings']) {
    assert.equal(classify(fixture(` * ${row}\n * 1 note\n`)).mergeAllowed, false, row);
  }
  const overflow = fixture(' * 9007199254740993 warnings\n', 2);
  overflow.checks[0]!.output.title = '9007199254740993 new alerts';
  assert.equal(classify(overflow).mergeAllowed, false);
  const hidden = fixture();
  hidden.checks[0]!.output.title = '3 new alerts including 1 high severity security vulnerability';
  assert.equal(classify(hidden).mergeAllowed, false);
  hidden.checks[0]!.output.summary += '\n * 1 high\n';
  assert.equal(classify(hidden).state, 'blocked');
});
