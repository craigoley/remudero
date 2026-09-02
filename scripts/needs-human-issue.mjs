#!/usr/bin/env node
// Delivery of record for UNATTENDED, SCHEDULED workflows.
//
// The problem this exists to solve: a scheduled job that fails produces a red badge on a page
// nobody opens. Every other failing check in this repo is attached to a PR, so a human sees it as
// a side effect of doing their normal work -- a cron job has no such carrier. `mutation-nightly`
// is the falsifier of record for ~15k lines of src/** that the PR-time gate deliberately does not
// mutate (see that workflow's header), and until this script existed its ONLY output on failure
// was that unread badge: the repo's broadest correctness signal was, in delivery terms, off.
//
// The four scheduled SECURITY scanners (codeql, osv-scanner, scorecard, semgrep) do NOT need this:
// each uploads SARIF, so its findings land as code-scanning alerts, which this repo already
// consumes through its alert-intake lane. mutation-nightly uploads no SARIF and raises no alert,
// which is what made it the outlier.
//
// IDEMPOTENT BY CONSTRUCTION, because the caller is a cron job. A nightly workflow that opened a
// fresh issue per failure would produce 365 issues a year and train the reader to ignore the
// label -- which would reproduce the very delivery gap this script closes, just one level up. So a
// run COMMENTS on the existing open issue when one is already tracking this source, and only
// OPENS one when none is. Identity is carried by an HTML-comment marker in the body rather than by
// the title, so that a human retitling the issue while triaging it does not fork a duplicate.
//
// Usage:
//   node scripts/needs-human-issue.mjs \
//     --source mutation-nightly --title "<title>" --body-file <path> [--preamble <text>] [--label needs-human]
//
// Exits 0 when delivered. Exits 1 when delivery FAILED -- a failure to notify must itself be
// loud, never a silent pass, or the job reports success while the human hears nothing.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// GitHub rejects an issue body over 65536 chars. A Stryker log or a sweep report can exceed that,
// so the body is trimmed to fit rather than being rejected at the API boundary -- a delivery that
// 422s is a delivery that did not happen.
export const MAX_BODY = 65536;

export function markerFor(source) {
  return `<!-- needs-human:${source} -->`;
}

// Pure. Given the open issues already carrying the label, decide whether this run appends to an
// existing thread or starts one. Marker match wins over title match (see the header).
export function decideDelivery(openIssues, marker) {
  const existing = (openIssues ?? []).find((i) => typeof i?.body === 'string' && i.body.includes(marker));
  return existing ? { action: 'comment', number: existing.number } : { action: 'create' };
}

// Pure. Keep the TAIL of the log: for every failure mode in scope the diagnosis is the last thing
// written (the ratchet prints its violations after the score line; a crashing step's stack is at
// the end), so trimming the head preserves the actionable part.
//
// ⚠ WHICH IS WHY A CALLER'S OWN DIAGNOSTIC MUST NOT RIDE INSIDE THE LOG. mutation-nightly wrote a
// `failing step: … stryker_failed_configs=…` line at the TOP of the file it passed as --body-file,
// and that line — the single most actionable thing in the delivery, naming which Stryker config
// errored — is the FIRST thing this function drops. MEASURED on issue #3387: a 65,538-char body
// (the cap) whose visible tail was entirely `ok` lines from a later, passing config, while the
// failure and the failing config's name had both been trimmed away. `buildBody`'s `preamble` sits
// in the ENVELOPE instead, outside the log and above the <details>, so it survives any log size.
export function truncateBody(body, max = MAX_BODY) {
  if (body.length <= max) return body;
  const notice = '\n\n_[log truncated -- earlier lines dropped to fit GitHub\'s issue-body limit; the full log is in the run and the uploaded artifact]_\n';
  return notice + body.slice(body.length - (max - notice.length));
}

// Pure. Body carries the marker (identity), the numbers (so the issue is actionable without
// opening the run), and the run URL (so it is not a dead end).
//
// THE LOG IS TRIMMED, NOT THE BODY, and that distinction is load-bearing. truncateBody() keeps the
// TAIL, and the marker sits at the HEAD -- so trimming the ASSEMBLED body drops the marker first,
// and a delivered issue whose body has no marker is invisible to decideDelivery(). The next run
// would then find no existing thread and OPEN A NEW ISSUE, every run, which is precisely the
// 365-issues-a-year failure this script's header says it exists to prevent. That is not
// hypothetical for this caller: MEASURED at ~276 bytes of Stryker clear-text output per surviving
// mutant, and mutation-nightly reports over 27,000 survivors -- its captured log is orders of
// magnitude past MAX_BODY, so the FIRST truncated delivery would have broken idempotency. Trimming
// the log alone keeps the envelope -- marker, headline, run URL -- intact at any log size.
export function buildBody({ source, marker, runUrl, log, when, preamble }) {
  const render = (logText) =>
    [
      marker,
      `**\`${source}\` failed** on its scheduled run${when ? ` (${when})` : ''}.`,
      '',
      'This is the delivery of record for a job with no PR to attach to -- it is not a duplicate of a check you have already seen.',
      '',
      `Run: ${runUrl || '(unknown)'}`,
      ...(preamble ? ['', preamble.trimEnd()] : []),
      '',
      '<details><summary>Captured output (stdout + stderr)</summary>',
      '',
      '```',
      logText,
      '```',
      '',
      '</details>',
    ].join('\n');

  const room = MAX_BODY - render('').length;
  const logText = truncateBody((log ?? '').trimEnd() || '(no output captured)', Math.max(0, room));
  // The outer call is a belt, not the mechanism: it only ever bites if the envelope itself were
  // grown past MAX_BODY, which no caller controls.
  return truncateBody(render(logText));
}

function ghJson(args, exec) {
  const out = exec('gh', args);
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

export function deliver(
  { source, title, body, label = 'needs-human', repo },
  exec = (file, args) => execFileSync(file, args, { encoding: 'utf8' }),
) {
  const marker = markerFor(source);
  const repoArgs = repo ? ['--repo', repo] : [];

  // A missing label must not sink the delivery: `gh issue list --label` errors when the label does
  // not exist yet, and an unnotified human is a worse outcome than an unlabelled issue.
  let open = [];
  try {
    open = ghJson(
      ['issue', 'list', ...repoArgs, '--state', 'open', '--label', label, '--limit', '100', '--json', 'number,body,title'],
      exec,
    );
  } catch {
    open = [];
  }

  const decision = decideDelivery(open, marker);
  if (decision.action === 'comment') {
    exec('gh', ['issue', 'comment', String(decision.number), ...repoArgs, '--body', body]);
    return { ...decision, marker };
  }
  const created = exec('gh', ['issue', 'create', ...repoArgs, '--title', title, '--label', label, '--body', body]);
  return { action: 'create', url: (created ?? '').trim(), marker };
}

// Every collaborator is injected LAST with a real default, so the CLI call stays `main()` while a
// test can drive the whole entry point without shelling out to `gh` or touching the filesystem.
// Returns the exit code rather than setting it, so the assertion is on a value, not a global.
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  deliverFn = deliver,
  log = console.log,
  error = console.error,
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      title: { type: 'string' },
      'body-file': { type: 'string' },
      // Sits in the ENVELOPE, above the <details>, and is never truncated — see truncateBody's
      // own note for the delivery this exists to stop losing.
      preamble: { type: 'string' },
      label: { type: 'string', default: 'needs-human' },
      repo: { type: 'string' },
    },
  });

  if (!values.source || !values.title) {
    error('needs-human-issue: --source and --title are required');
    return 1;
  }

  const body = buildBody({
    source: values.source,
    marker: markerFor(values.source),
    runUrl: env.RUN_URL,
    log: values['body-file'] ? readFile(values['body-file']) : '',
    preamble: values.preamble,
    when: env.RUN_WHEN,
  });

  try {
    const result = deliverFn({
      source: values.source,
      title: values.title,
      body,
      label: values.label,
      repo: values.repo,
    });
    log(
      result.action === 'comment'
        ? `needs-human-issue: commented on existing issue #${result.number} (marker ${result.marker})`
        : `needs-human-issue: opened ${result.url}`,
    );
    return 0;
  } catch (err) {
    // Loud: a delivery that failed must not leave the job looking green-adjacent.
    error(`needs-human-issue: DELIVERY FAILED -- ${err.message}`);
    return 1;
  }
}

// Only run as a CLI, so importing this from a test never shells out to `gh`. Kept to ONE line on
// purpose: the guard's body can only execute in a child process, so splitting it across lines
// leaves an permanently-uncovered added line (the same shape scripts/clock-sweep.mjs uses).
// `process.exitCode` rather than `process.exit()` so a piped stdout is never truncated mid-write.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
