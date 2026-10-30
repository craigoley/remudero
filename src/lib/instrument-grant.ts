/**
 * W1-T11029 — AN INSTRUMENT EDIT IS JUDGED IN SHADOW BEFORE IT ESCALATES (operator ruling 2026-10-30: "Judged grant,
 * shadow first").
 *
 * A fix round that needs an instrument path (`isUngrantableInstrumentPath`, proof-amendment.ts) stands down and asks
 * the operator, and that one rule held four fleet PRs on 2026-10-30 (#15133, #15046, #15368, #15520) while the worker
 * had already written and tested the edit (a stopping clock registered in a census table, an import map updated).
 * The ruling: a judge may admit such an edit only when it purely adds — registers an entry, tightens — and removes or
 * loosens nothing. This module is the SHADOW half: at the stand-down it reads the worker's uncommitted instrument diff,
 * classifies every requested path mechanically, saves the patch for the operator's spot-check and ledgers what it
 * WOULD do. It grants nothing and never changes the escalation; W1-T11030 acts after 48 h of this evidence and the
 * operator's spot-check.
 *
 * ADDITIVE IS A LINE FACT, NOT A JUDGEMENT: a path is `additive` when its diff adds at least one line and removes
 * none (a new file counts). Any removed or changed line, a deletion, a mode change or a binary diff is `modifies`; a
 * requested path with no diff is `absent`. A baseline whose number moves is therefore `modifies`, never guessed
 * "tighter". The round would be granted only when EVERY requested path is additive.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";

export const INSTRUMENT_GRANT_SHADOW_STEP = "instrument_grant.shadow";
export const INSTRUMENT_GRANT_SHADOW_DIR = "instrument-grant-shadow";

export type InstrumentPathVerdict = "additive" | "modifies" | "absent";

export interface InstrumentPathJudgement {
  path: string;
  verdict: InstrumentPathVerdict;
  added: number;
  removed: number;
  reason: string;
}

export interface InstrumentGrantJudgement {
  verdict: "would_grant" | "would_escalate";
  paths: InstrumentPathJudgement[];
  reason: string;
}

interface FileDiff { path: string; added: number; removed: number; structural?: string }

/** Split a unified `git diff` into per-file line counts, naming any change that is not a plain line edit. */
function parseUnifiedDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let current: FileDiff | undefined;
  let oldLines = 0;
  let newLines = 0;
  for (const line of diff.split("\n")) {
    if (oldLines === 0 && newLines === 0) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (header) {
        current = { path: header[2]!, added: 0, removed: 0 };
        files.set(current.path, current);
        continue;
      }
    }
    if (!current) continue;
    if (oldLines > 0 || newLines > 0) {
      if (line.startsWith(" ")) { oldLines--; newLines--; }
      else if (line.startsWith("+")) { current.added++; newLines--; }
      else if (line.startsWith("-")) { current.removed++; oldLines--; }
      // A "\ No newline at end of file" marker consumes neither side of the hunk.
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLines = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLines = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (/^deleted file mode /.test(line)) current.structural = "the file is deleted";
    else if (/^(old|new) mode /.test(line)) current.structural = "the file mode changes";
    else if (/^Binary files /.test(line)) current.structural = "the diff is binary";
    else if (/^rename (from|to) /.test(line)) current.structural = "the file is renamed";
  }
  return files;
}

/** PURE: the shadow verdict for the instrument paths a round asked for, from the worker's uncommitted diff. */
export function classifyInstrumentDiff(diff: string, requestedPaths: readonly string[]): InstrumentGrantJudgement {
  const files = parseUnifiedDiff(diff);
  const paths = [...new Set(requestedPaths)].sort().map((path): InstrumentPathJudgement => {
    const file = files.get(path);
    if (!file) return { path, verdict: "absent", added: 0, removed: 0, reason: "the worker's diff does not touch this path" };
    const base = { path, added: file.added, removed: file.removed };
    if (file.structural) return { ...base, verdict: "modifies", reason: file.structural };
    if (file.removed > 0) return { ...base, verdict: "modifies", reason: `removes or changes ${file.removed} line(s)` };
    if (file.added === 0) return { ...base, verdict: "absent", reason: "the diff adds no line" };
    return { ...base, verdict: "additive", reason: `adds ${file.added} line(s) and removes none` };
  });
  const blocking = paths.filter((p) => p.verdict !== "additive");
  return {
    verdict: paths.length > 0 && blocking.length === 0 ? "would_grant" : "would_escalate",
    paths,
    reason: paths.length === 0 ? "no instrument path was requested"
      : blocking.length === 0 ? "every requested instrument path only adds lines"
      : blocking.map((p) => `${p.path}: ${p.reason}`).join("; "),
  };
}

/** The saved patch's path, or why it could not be written: the two outcomes stay distinct in the ledger row. */
function savePatch(path: string, diff: string): { patch_path: string } | { patch_error: string } {
  try {
    writeAtomic(path, diff);
    return { patch_path: path };
  } catch (error) {
    // The failed write is reported, not erased: patch_error replaces patch_path in the row.
    return { patch_error: String((error as Error)?.message ?? error) };
  }
}

export interface InstrumentGrantShadowInput {
  worktreePath: string;
  instrumentPaths: readonly string[];
  stateDir: string;
  roundId: string;
  prNumber: number | undefined;
  headSha: string;
  git: (cwd: string, args: string[]) => Promise<string>;
  log: (step: string, fields: Record<string, unknown>) => void;
}

/** Record the shadow judgement for one instrument stand-down. Never throws: shadow must not change the escalation. */
export async function recordInstrumentGrantShadow(input: InstrumentGrantShadowInput): Promise<InstrumentGrantJudgement | undefined> {
  const base = { pr_number: input.prNumber, round_id: input.roundId, head_sha: input.headSha, paths: [...input.instrumentPaths].sort() };
  let diff: string;
  try {
    diff = await input.git(input.worktreePath, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ...base.paths]);
  } catch (error) {
    // Shadow only: an unreadable diff is ledgered as its own verdict, never thrown into the escalation it observes.
    input.log(INSTRUMENT_GRANT_SHADOW_STEP, { ...base, verdict: "unreadable", reason: `the worker's diff could not be read: ${String((error as Error)?.message ?? error)}` });
    return undefined;
  }
  const judgement = classifyInstrumentDiff(diff, base.paths);
  const patchSha256 = createHash("sha256").update(diff).digest("hex");
  const patchPath = join(input.stateDir, INSTRUMENT_GRANT_SHADOW_DIR, `${input.roundId.replace(/[^A-Za-z0-9._-]/g, "_")}.patch`);
  const saved = savePatch(patchPath, diff);
  input.log(INSTRUMENT_GRANT_SHADOW_STEP, {
    ...base, verdict: judgement.verdict, reason: judgement.reason, patch_sha256: patchSha256, ...saved,
    judged: judgement.paths.map((p) => ({ path: p.path, verdict: p.verdict, added: p.added, removed: p.removed })),
  });
  return judgement;
}
