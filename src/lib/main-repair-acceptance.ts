/**
 * W1-T11291 — A MAIN REPAIR'S ACCEPTANCE PROOF IS THE RED SUITE, NEVER A COMMENT LINE.
 *
 * 2026-11-03: #16634 was a correct repair of a red main, yet both local reviews CAPPED it (0/1 proofs executed). The
 * dispatcher had rewritten its inert body to a `grep:` of the repair's FIRST added line, and that line was a `//`
 * comment, which `review.ts` grades `executed_stale`. CAPPED cannot arm, so main stayed red until an operator acted.
 *
 * Two repairs live here, outside `src/run-task.ts` so a test can import them without the CLI entrypoint:
 * the red suites a repair was dispatched for are the proof that fails at the base by construction, and
 * {@link diffAnchor} never anchors on a line the reviewer's own comment classifier reads as a comment.
 */
import { breMetacharsIn } from "./bre-metachars.js";
import type { AcceptanceCriterion } from "./plan.js";
import { renderAcceptanceBlock } from "./plan-pr-emitter.js";
import { inertAcceptanceProofs } from "./proof-grammar.js";
import {
  acceptanceBlockRegion,
  matchedLinesAreAllComments,
  parseAcceptanceBlock,
  parseWhitelistedProof,
  wrappedGrepPattern,
} from "./review.js";

export type DiffAnchorUnavailableReason = "no-diff" | "unparseable" | "no-safe-candidate";
export type DiffAnchor = { kind: "anchored"; path: string; line: string; proof: string } | { kind: "unavailable"; reason: DiffAnchorUnavailableReason };
const DIFF_ANCHOR_MIN_LENGTH = 8;

function escapeGrepLiteral(line: string): string {
  let escaped = "";
  for (const ch of line) {
    if (ch === "\\") escaped += "\\\\";
    else if (ch === "?") escaped += "[?]";
    else if (".[]*^$".includes(ch)) escaped += `\\${ch}`;
    else escaped += ch;
  }
  return escaped;
}

/** Reads a repo-relative path at the head the diff was taken against; `undefined` when it cannot be read. */
export type DiffAnchorFileReader = (path: string) => string | undefined;

/** True when the reviewer's own classifier ({@link matchedLinesAreAllComments}) reads this added line as a comment in
 *  `path`'s language. With the file's text at head and the line's number, the classifier sees the whole file, so a
 *  line inside a block comment is read as one; without them it judges the line alone. */
function addedLineIsComment(path: string, line: string, lineNumber: number | undefined, fileText: string | undefined): boolean {
  if (fileText !== undefined && lineNumber !== undefined) {
    return matchedLinesAreAllComments([`${lineNumber}:${line}`], { pattern: line, fileText, path });
  }
  return matchedLinesAreAllComments([line], { pattern: line, fileText: "", path });
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The first ADDED line of a unified diff (`git diff` or `gh pr diff`) that yields a grep proof the reviewer can run
 *  and that cannot already match at the merge base. A line the same diff also REMOVES is a move, so it is skipped,
 *  and so is a line the reviewer would read as a comment (W1-T11291: such a grep grades `executed_stale`). */
export function diffAnchor(diffText: string | undefined, readFile?: DiffAnchorFileReader): DiffAnchor {
  if (diffText === undefined || diffText.trim() === "") return { kind: "unavailable", reason: "no-diff" };
  const added: Array<{ path: string; line: string; lineNumber: number | undefined }> = [];
  const removed = new Set<string>();
  let file: string | undefined;
  let sawHeader = false;
  let newLine: number | undefined;
  for (const raw of diffText.split("\n").map((l) => l.replace(/\r$/, ""))) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      newLine = undefined;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      sawHeader = true;
      const path = raw.slice(4).replace(/^b\//, "").trim();
      file = path === "/dev/null" ? undefined : path;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = HUNK_HEADER_RE.exec(raw);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("-")) removed.add(raw.slice(1).trim());
    else if (raw.startsWith("+")) {
      if (file) added.push({ path: file, line: raw.slice(1).trim(), lineNumber: newLine });
      if (newLine !== undefined) newLine += 1;
    } else if (raw.startsWith(" ") && newLine !== undefined) newLine += 1;
  }
  if (!sawHeader) return { kind: "unavailable", reason: "unparseable" };
  const texts = new Map<string, string | undefined>();
  const textAt = (path: string): string | undefined => {
    if (!texts.has(path)) texts.set(path, readFile?.(path));
    return texts.get(path);
  };
  for (const { path, line, lineNumber } of added) {
    if (line.length < DIFF_ANCHOR_MIN_LENGTH || removed.has(line) || /\sin\s/i.test(line)) continue;
    if (!/\.[^/]+$/.test(path) || /\s/.test(path) || path.includes("..")) continue;
    if (addedLineIsComment(path, line, lineNumber, textAt(path))) continue;
    const pattern = escapeGrepLiteral(line);
    const proof = `grep: ${pattern} in ${path}`;
    if (parseWhitelistedProof(proof) === null || breMetacharsIn(pattern).blocking.length > 0) continue;
    if (wrappedGrepPattern(proof) !== undefined) continue;
    // The proof must survive the block it is written into, verbatim.
    const roundTrip = parseAcceptanceBlock(renderAcceptanceBlock([{ claim: "anchor", proof }]));
    if (roundTrip.length !== 1 || roundTrip[0].proof !== proof) continue;
    return { kind: "anchored", path, line, proof };
  }
  return { kind: "unavailable", reason: "no-safe-candidate" };
}

export type MainRepairAcceptanceVerdict =
  | { body: string }
  | { body: string; defect: "inert-proofs" | "no-proofs"; inert: string[]; resolution: "rewritten" }
  | { defect: "inert-proofs" | "no-proofs"; inert: string[]; resolution: "refused"; reason: DiffAnchorUnavailableReason };

/** One `unit test:` criterion per red suite the repair was dispatched for, skipping a proof already in `taken`. A red
 *  suite fails at the base by definition, so this proof discriminates by construction. */
function redSuiteCriteria(redTestFiles: readonly string[], taken: ReadonlySet<string>): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  for (const path of new Set(redTestFiles)) {
    const proof = `unit test: ${path}`;
    if (taken.has(proof) || parseWhitelistedProof(proof) === null) continue;
    out.push({ claim: `${path} passes again on the repaired head`, proof });
  }
  return out;
}

/**
 * W1-T8572 / W1-T11291 — a no-test-file worker body, checked BEFORE the dispatcher opens it. A body whose proofs all
 * execute is returned as written. Otherwise its inert bullets are dropped and replaced by, in order: a `unit test:`
 * of each red suite in `redTestFiles` (the `test_files` of `main.repair.located`); failing that, one `grep:` of a
 * non-comment line the pushed fix ADDS ({@link diffAnchor}); with neither the body is refused.
 */
export function mainRepairAcceptanceFor(args: {
  body: string;
  diffText: string | undefined;
  redTestFiles?: readonly string[];
  readFile?: DiffAnchorFileReader;
}): MainRepairAcceptanceVerdict {
  const { body, diffText, readFile } = args;
  const criteria = parseAcceptanceBlock(body);
  const inert = inertAcceptanceProofs(body);
  if (criteria.length > 0 && inert.length === 0) return { body };
  const defect = criteria.length === 0 ? "no-proofs" : "inert-proofs";
  const inertSet = new Set(inert);
  const kept = criteria.filter((c) => !inertSet.has(c.proof ?? "")) as AcceptanceCriterion[];
  const red = redSuiteCriteria(args.redTestFiles ?? [], new Set(kept.map((c) => c.proof ?? "")));
  let added: AcceptanceCriterion[] = red;
  if (red.length === 0) {
    const anchor = diffAnchor(diffText, readFile);
    if (anchor.kind === "unavailable") return { defect, inert, resolution: "refused", reason: anchor.reason };
    added = [{ claim: `the pushed repair adds this line to ${anchor.path}`, proof: anchor.proof }];
  }
  const block = renderAcceptanceBlock([...kept, ...added]);
  const region = acceptanceBlockRegion(body);
  const lines = body.split("\n");
  const rewritten =
    region === undefined
      ? `${body.replace(/\s*$/, "")}\n\n${block}\n`
      : [...lines.slice(0, region.headerLine), block, ...lines.slice(region.endLine)].join("\n");
  return { body: rewritten, defect, inert, resolution: "rewritten" };
}
