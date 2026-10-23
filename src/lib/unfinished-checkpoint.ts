/**
 * A build whose tip is `chore(checkpoint):` or a legacy `wip:` checkpoint is unfinished. The worker contract
 * (compaction.ts, CHECKPOINT AS YOU GO) makes checkpoints ADDITIONAL to a terminal commit, and
 * their `[remudero-context]` body names what is still `remaining`. #10482 (W1-T6434) opened on
 * such a tip: titled "chore(wip): …" and carrying four reds the build's own remaining steps
 * ("final ratchets and neighbouring suites") would have caught. These helpers let the harness
 * resume the worker to finish, and never title a PR after a checkpoint. The first stop always
 * resumes; whether a later stop resumes again is the W1-T7096 progress judge's call.
 */
import { checkCommitMessage, CONVENTIONAL_LIMITS, fitConventionalTitle, isWipSubject, normalizeSubjectCase, stripWipMarker } from "./commit-message.js";
import type { FixProgressInput, FixProgressJudge } from "./fix-progress-judge.js";

export { isWipSubject, stripWipMarker };

/** One stop on a checkpoint tip: its 1-based ordinal, the checkpoint subject and its `remaining` line.
 *  `workingTree` is the round's uncommitted diff stat (W1-T9030): a harness-owned build never commits, so
 *  without it the judge reads an unmoved tip as "no recorded progress". */
export interface CheckpointStop { round: number; subject: string; remaining?: string; workingTree?: string }

/** Who wrote the tip a round ended on, and whether the round itself moved HEAD. */
export interface RoundTip { tipAuthor: "worker" | "harness"; headMoved: boolean; unfinished: boolean }

/**
 * W1-T9030: a round is judged by what it DID, not by the tip's subject. A tip whose head is the one recorded
 * before the round was written by the harness (the restore merge, an earlier checkpoint) and is never the
 * worker's stop: with its completion line (`finishedByReport`) the round is finished. Only a wip-shaped tip the
 * round itself moved HEAD to is a worker checkpoint stop. An unreadable head counts as moved, the old behaviour.
 */
export function classifyRoundTip(input: {
  tipSubject: string | undefined; headBefore: string | undefined; headNow: string | undefined;
  finishedByReport: boolean; reportOpenedPr: boolean;
}): RoundTip {
  const headMoved = input.headBefore === undefined || input.headNow === undefined || input.headBefore !== input.headNow;
  const tipAuthor = headMoved ? "worker" : "harness";
  const wipTip = input.tipSubject !== undefined && isWipSubject(input.tipSubject);
  const unfinished = wipTip && !input.reportOpenedPr && (headMoved || !input.finishedByReport);
  return { tipAuthor, headMoved, unfinished };
}

/** Whether the harness resumes the worker again, and why. */
export type CheckpointResumeDecision =
  | { resume: true; by: "first-stop" | "judge"; reason: string }
  | { resume: false; by: "stand-in" | "judge" | "backstop"; reason: string };

/** A safety backstop only: the judge decides every later stop, this bounds a judge that never stops. */
export const CHECKPOINT_RESUME_BACKSTOP = 8;

/** The judge's input for checkpoint stops: each stop is a round whose "red" is its remaining work. */
export function checkpointProgressInput(stops: readonly CheckpointStop[], headSha: string): FixProgressInput {
  const red = (s: CheckpointStop) => [
    `checkpoint remaining: ${s.remaining ?? "(not recorded)"}`,
    ...(s.workingTree ? [`uncommitted work this round: ${s.workingTree}`] : []),
  ];
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
    signals: { noOpRounds: 0, identicalRedSets: identical, identicalDiffs: 0, oscillating: false, refusedRounds: 0, incompleteRounds: 0,
      reviewerOnlyFailurePersists: 0 },
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

/** A conventional header for unfinished work; the body/context/trailers remain the caller's. */
export function checkpointCommitSubject(reason: string): string {
  const subject = normalizeSubjectCase(reason.replace(/\s+/g, " ").trim().replace(/\.+$/, "")) || "retain unfinished work";
  return fitConventionalTitle(`chore(checkpoint): ${subject}`).header;
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
    : "make the terminal commit (a conventional subject, never `wip:` or `chore(wip):` or `chore(checkpoint):`), `git push origin HEAD`, and end with the REPORT from before.";
  return (
    `Your branch tip is a checkpoint, not a finished build: "${subject.trim()}". ${left} ` +
    `Finish that remaining work now, run \`rmd preflight --fast\` and fix what it reports, then ${finish} ` +
    "The terminal message must not be a checkpoint. Local validation checks the commit range too; " +
    "legacy checkpoint history remains unfinished, not exempt from those gates."
  );
}

/** A PR title from the branch's own subjects, newest first: the newest non-checkpoint subject, else
 *  the newest subject with its checkpoint marker removed. Undefined only for an empty list. */
export function prTitleFromBranchCommits(subjects: readonly string[]): string | undefined {
  const real = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  if (real.length === 0) return undefined;
  return real.find((s) => !isWipSubject(s)) ?? stripWipMarker(real[0]!);
}

const CONVENTIONAL_HEAD = /^([a-z]+)(\([^)]*\))?(!?):\s*/;

/** A merge's subject: git's own `Merge branch …` / `Merge remote-tracking branch …`, or a conventional one
 *  whose description merges something INTO the branch, as the harness's restore merge does (#10936). */
function isMergeSubject(subject: string): boolean {
  if (/^Merge\b/.test(subject)) return true;
  const head = CONVENTIONAL_HEAD.exec(subject);
  return /^merge\b.*\binto\b/i.test(head ? subject.slice(head[0].length) : subject);
}

/** The `type(scope)!: ` of the newest real conventional subject (newest first), else `feat: `. A checkpoint
 *  and a merge lend nothing: their words and their type are the harness's, never the change's. */
function taskTitlePrefix(subjects: readonly string[]): string {
  for (const subject of subjects.map((s) => s.trim())) {
    if (!subject || isWipSubject(subject) || isMergeSubject(subject)) continue;
    const head = CONVENTIONAL_HEAD.exec(subject);
    if (head && !checkCommitMessage(`${head[1]}: x`).some((v) => v.rule === "type-enum")) return `${head[1]}${head[2] ?? ""}${head[3]}: `;
  }
  return "feat: ";
}

/** W1-T7952: a filed build PR's title, from its task and never from a checkpoint's or a merge's words. The
 *  subject is the shard title's lead clause (before the first " — "), lower-cased for subject-case, then
 *  " (<task id>)"; the type and scope come from the branch's newest real conventional subject, else `feat`.
 *  Fitted to header-max-length with the id kept. Undefined when the task has no title or id. */
export function prTitleForTask(subjects: readonly string[], task: { id: string; title?: string }): string | undefined {
  const lead = (task.title ?? "").split(" — ")[0]!.replace(/\s+/g, " ").trim().replace(/[\s.]+$/, "").toLowerCase();
  const id = task.id.trim();
  if (!lead || !id) return undefined;
  const suffix = ` (${id})`;
  const { header } = fitConventionalTitle(`${taskTitlePrefix(subjects)}${lead}`, CONVENTIONAL_LIMITS.headerMaxLength - suffix.length);
  return `${header}${suffix}`;
}
