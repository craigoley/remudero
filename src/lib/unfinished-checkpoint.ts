/**
 * A build whose branch tip is a `wip:` checkpoint is unfinished. The worker contract
 * (compaction.ts, CHECKPOINT AS YOU GO) makes checkpoints ADDITIONAL to a terminal commit, and
 * their `[remudero-context]` body names what is still `remaining`. #10482 (W1-T6434) opened on
 * such a tip: titled "chore(wip): …" and carrying four reds the build's own remaining steps
 * ("final ratchets and neighbouring suites") would have caught. These helpers let the harness
 * resume the worker to finish, and never title a PR after a checkpoint. The first stop always
 * resumes; whether a later stop resumes again is the W1-T7096 progress judge's call.
 */
import type { FixProgressInput, FixProgressJudge } from "./fix-progress-judge.js";

/** One stop on a checkpoint tip: its 1-based ordinal, the checkpoint subject and its `remaining` line. */
export interface CheckpointStop { round: number; subject: string; remaining?: string }

/** Whether the harness resumes the worker again, and why. */
export type CheckpointResumeDecision =
  | { resume: true; by: "first-stop" | "judge"; reason: string }
  | { resume: false; by: "stand-in" | "judge" | "backstop"; reason: string };

/** A safety backstop only: the judge decides every later stop, this bounds a judge that never stops. */
export const CHECKPOINT_RESUME_BACKSTOP = 8;

/** The judge's input for checkpoint stops: each stop is a round whose "red" is its remaining work. */
export function checkpointProgressInput(stops: readonly CheckpointStop[], headSha: string): FixProgressInput {
  const red = (s: CheckpointStop) => [`checkpoint remaining: ${s.remaining ?? "(not recorded)"}`];
  let identical = 0;
  for (let i = 1; i < stops.length; i++) {
    if ((stops[i]!.remaining ?? "") === (stops[i - 1]!.remaining ?? "")) identical++;
  }
  return {
    headSha,
    strikesSpent: stops.length - 1,
    currentRed: red(stops[stops.length - 1]!),
    rounds: stops.slice(0, -1).map((s, i) => ({
      id: `checkpoint-${s.round}`, subtype: "checkpoint-stop", redBefore: red(s), redAfter: red(stops[i + 1]!), completed: true,
    })),
    parkedReason: "the build stopped on a wip checkpoint again; resume it or open the PR with the remaining work as known reds",
    signals: { noOpRounds: 0, identicalRedSets: identical, identicalDiffs: 0, oscillating: false, refusedRounds: 0, incompleteRounds: 0 },
  };
}

/** The first stop resumes; a later stop resumes only on the judge's continue or change-approach.
 *  With no judge wired (test fixtures) the stand-in keeps the former resume-once behaviour. */
export async function decideCheckpointResume(
  stops: readonly CheckpointStop[],
  headSha: string,
  judge?: FixProgressJudge,
): Promise<CheckpointResumeDecision> {
  if (stops.length <= 1) return { resume: true, by: "first-stop", reason: "the first checkpoint stop always resumes" };
  if (stops.length > CHECKPOINT_RESUME_BACKSTOP) {
    return { resume: false, by: "backstop", reason: `safety backstop: ${stops.length} checkpoint stops` };
  }
  if (!judge) return { resume: false, by: "stand-in", reason: "no progress judge wired; the stand-in resumes once" };
  let verdict;
  try {
    verdict = await judge(checkpointProgressInput(stops, headSha));
  } catch (error) {
    return { resume: false, by: "judge", reason: `checkpoint judgment failed: ${String(error)}` };
  }
  if (verdict?.verdict === "continue" || verdict?.verdict === "change-approach") {
    return { resume: true, by: "judge", reason: verdict.reason };
  }
  if (verdict?.verdict === "escalate") return { resume: false, by: "judge", reason: `${verdict.loop}: ${verdict.reason}` };
  return { resume: false, by: "judge", reason: "absent checkpoint verdict; opening the PR" };
}

/** {@link decideCheckpointResume} for the harness: reads the tip head, and builds the judge only for a
 *  later stop, so the first stop never spawns one. Both are seams; an unreadable head is named, not guessed. */
export async function judgeCheckpointStop(
  stops: readonly CheckpointStop[],
  seams: { readHead: () => string; makeJudge: () => FixProgressJudge | undefined },
): Promise<CheckpointResumeDecision> {
  let head: string;
  try {
    head = seams.readHead().trim();
  } catch (error) {
    head = `unreadable: ${String(error)}`;
  }
  return decideCheckpointResume(stops, head, stops.length > 1 ? seams.makeJudge() : undefined);
}

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
