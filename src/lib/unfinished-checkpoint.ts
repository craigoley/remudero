/**
 * A build whose branch tip is a `wip:` checkpoint is unfinished. The worker contract
 * (compaction.ts, CHECKPOINT AS YOU GO) makes checkpoints ADDITIONAL to a terminal commit, and
 * their `[remudero-context]` body names what is still `remaining`. #10482 (W1-T6434) opened on
 * such a tip: titled "chore(wip): …" and carrying four reds the build's own remaining steps
 * ("final ratchets and neighbouring suites") would have caught. These helpers let the harness
 * resume the worker once to finish, and never title a PR after a checkpoint.
 */

const WIP_HEAD = /^(?:wip(\([^)]*\))?|([a-z]+)\(wip\))(!?):\s*/i;

/** True for `wip: x`, `wip(scope): x` and `chore(wip): x` subjects. */
export function isWipSubject(subject: string): boolean {
  return WIP_HEAD.test(subject.trim());
}

/** `chore(wip): x` -> `chore: x`; `wip: x` -> `chore: x`; `wip(s): x` -> `chore(s): x`. */
export function stripWipMarker(subject: string): string {
  const trimmed = subject.trim();
  const match = WIP_HEAD.exec(trimmed);
  if (!match) return trimmed;
  const rest = trimmed.slice(match[0].length);
  const type = match[2] ?? "chore";
  const scope = match[1] ?? "";
  return `${type.toLowerCase()}${scope}${match[3]}: ${rest}`;
}

/** The `remaining` line of a checkpoint's `[remudero-context]` block, unless it says nothing is left. */
export function checkpointRemaining(body: string): string | undefined {
  const at = body.indexOf("[remudero-context]");
  if (at < 0) return undefined;
  for (const line of body.slice(at).split("\n")) {
    const m = /^\s*[-*]?\s*remaining\s*[:\-–]\s*(.*)$/i.exec(line);
    if (!m) continue;
    const text = m[1]!.trim();
    if (!text || /^(none|nothing|n\/a|-|—)\.?$/i.test(text)) return undefined;
    return text;
  }
  return undefined;
}

/** The resume instruction for a worker that ended on a checkpoint tip. */
export function renderContinuationPrompt(subject: string, remaining: string | undefined, harnessOwnsGit: boolean): string {
  const left = remaining ? `Its [remudero-context] says remaining: ${remaining}.` : "It records no terminal commit.";
  const finish = harnessOwnsGit
    ? "save your edits, run NO git or gh commands, and end with a REPORT carrying `COMMIT_MESSAGE: <type>(<scope>): <subject>`."
    : "make the terminal commit (a conventional subject, never `wip:`), `git push origin HEAD`, and end with the REPORT from before.";
  return (
    `Your branch tip is a checkpoint, not a finished build: "${subject.trim()}". ${left} ` +
    `Finish that remaining work now, run \`rmd preflight --fast\` and fix what it reports, then ${finish}`
  );
}

/** A PR title from the branch's own subjects, newest first: the newest non-checkpoint subject, else
 *  the newest subject with its checkpoint marker removed. Undefined only for an empty list. */
export function prTitleFromBranchCommits(subjects: readonly string[]): string | undefined {
  const real = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  if (real.length === 0) return undefined;
  return real.find((s) => !isWipSubject(s)) ?? stripWipMarker(real[0]!);
}
