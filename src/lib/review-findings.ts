/** Optional reviewer findings. This module is telemetry, never a review gate. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

type Anchor = { path: string; line: number; kind: "changed" | "dependency"; changedProducer?: { path: string; line: number } };
type Candidate = { criterion: number; category: string; severity: "low" | "medium" | "high"; mechanism: string; remedy: string | null; anchor: Anchor };
export type ReviewFinding = Omit<Candidate, "anchor"> & {
  id: string;
  anchor: Anchor & { status: "verified" | "unsupported"; evidenceDigest: string };
};
export type FindingCapture = {
  state: "unavailable" | "zero" | "captured" | "partial";
  findings: ReviewFinding[];
  verifiedCount: number;
  invalidCount: number;
  droppedCount: number;
};

const MAX_OUTPUT_CHARS = 65_536;
const MAX_FINDINGS = 8;
const MAX_FILE_BYTES = 1_048_576;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function candidate(value: unknown, criteriaCount: number): Candidate | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const anchor = row.anchor as Record<string, unknown> | undefined;
  const producer = anchor?.changedProducer as Record<string, unknown> | undefined;
  if (!Number.isInteger(row.criterion) || Number(row.criterion) < 1 || Number(row.criterion) > criteriaCount ||
      typeof row.category !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(row.category) ||
      !["low", "medium", "high"].includes(String(row.severity)) ||
      typeof row.mechanism !== "string" || !row.mechanism.trim() || row.mechanism.length > 500 ||
      !(row.remedy === null || (typeof row.remedy === "string" && row.remedy.length <= 500)) ||
      !anchor || typeof anchor.path !== "string" || anchor.path.length > 240 ||
      !Number.isInteger(anchor.line) || Number(anchor.line) < 1 ||
      !["changed", "dependency"].includes(String(anchor.kind)) ||
      (producer !== undefined && (typeof producer.path !== "string" || producer.path.length > 240 || !Number.isInteger(producer.line) || Number(producer.line) < 1))) return undefined;
  return {
    criterion: row.criterion as number, category: row.category, severity: row.severity as Candidate["severity"],
    mechanism: row.mechanism.trim(), remedy: typeof row.remedy === "string" ? row.remedy.trim() : null,
    anchor: { path: anchor.path, line: anchor.line as number, kind: anchor.kind as Anchor["kind"],
      ...(producer ? { changedProducer: { path: producer.path as string, line: producer.line as number } } : {}) },
  };
}

function addedLines(diff: string): Map<string, string> {
  const lines = new Map<string, string>();
  let path = "";
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) { path = ""; inHunk = false; }
    else if (raw.startsWith("+++ b/")) { path = raw.slice(6); inHunk = false; }
    else if (raw.startsWith("@@ ")) {
      const match = /\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
      inHunk = !!match && !!path;
      if (match) line = Number(match[1]);
    } else if (inHunk && raw.startsWith("+")) { lines.set(`${path}:${line++}`, raw.slice(1)); }
    else if (inHunk && raw.startsWith(" ")) line++;
    else if (inHunk && !raw.startsWith("-") && !raw.startsWith("\\")) inHunk = false;
  }
  return lines;
}

function fileLine(root: string, path: string, line: number): string | undefined {
  if (!path || isAbsolute(path) || path.split("/").includes("..") || path.includes("\\")) return undefined;
  try {
    const base = realpathSync(root);
    const target = realpathSync(resolve(base, path));
    const rel = relative(base, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      return readFileSync(fd, "utf8").split("\n")[line - 1];
    } finally {
      closeSync(fd);
    }
  } catch { /* Unreadable or missing anchor file: no anchor text, so the finding stays unverified. */ return undefined; }
}

export function extractReviewFindings(input: {
  owner: string; repo: string; prUrl: string; headSha: string; root: string;
  diff: string; criteriaCount: number; text: string;
}): FindingCapture {
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  let droppedCount = 0;
  const truncated = input.text.length > MAX_OUTPUT_CHARS;
  const text = input.text.slice(-MAX_OUTPUT_CHARS);
  const rows = text.split(/\r?\n/).filter((line) => /^\s*REVIEW_FINDING\s/.test(line));
  const none = /^\s*REVIEW_FINDINGS:\s*NONE\s*$/m.test(text);
  if (rows.length === 0 && !none) return { state: "unavailable", findings, verifiedCount: 0, invalidCount: 0, droppedCount: 0 };
  if (input.diff.length > 2_097_152) return { state: "partial", findings, verifiedCount: 0, invalidCount: 0, droppedCount: rows.length };
  const changed = addedLines(input.diff);
  let exactHead = false;
  try {
    exactHead = execFileSync("git", ["-C", input.root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim() === input.headSha;
  } catch { /* Unsupported evidence is not a verified catch. */ }
  for (const row of rows) {
    if (findings.length >= MAX_FINDINGS) { droppedCount++; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(row.replace(/^\s*REVIEW_FINDING\s+/, "")); }
    catch { /* Malformed JSON row: counted in invalidCount, never surfaced as a finding. */ invalidCount++; continue; }
    const item = candidate(parsed, input.criteriaCount);
    if (!item) { invalidCount++; continue; }
    const anchorText = fileLine(input.root, item.anchor.path, item.anchor.line);
    const expected = changed.get(`${item.anchor.path}:${item.anchor.line}`);
    const producer = item.anchor.changedProducer;
    const producerText = producer ? fileLine(input.root, producer.path, producer.line) : undefined;
    const producerExpected = producer ? changed.get(`${producer.path}:${producer.line}`) : undefined;
    const verified = exactHead && anchorText !== undefined && (
      item.anchor.kind === "changed" ? expected !== undefined && expected === anchorText :
        expected === undefined && producerText !== undefined && producerExpected !== undefined && producerExpected === producerText
    );
    const evidenceDigest = digest(JSON.stringify([item.anchor.path, item.anchor.line, anchorText ?? null, producer ?? null, producerText ?? null]));
    const id = digest(JSON.stringify([input.owner, input.repo, input.prUrl, input.headSha, item.criterion, item.category, evidenceDigest]));
    if (seen.has(id)) { droppedCount++; continue; }
    seen.add(id);
    findings.push({ ...item, id, anchor: { ...item.anchor, status: verified ? "verified" : "unsupported", evidenceDigest } });
  }
  const verifiedCount = findings.filter((item) => item.anchor.status === "verified").length;
  return { state: invalidCount || droppedCount || truncated || none && rows.length ? "partial" : findings.length ? "captured" : "zero", findings, verifiedCount, invalidCount, droppedCount };
}

/** Replay is suppressed by the caller's exact-head review-decision claim; IDs also dedup one transcript. */
export function recordReviewFindings(capture: FindingCapture, input: {
  taskId: string; prUrl: string; headSha: string; decisionDigest: string;
  provenance: { provider: string | null; requestedModel: string | null; servedModel: string | null; effort: string | null; sessionId: string | null; selectionAssignmentId?: string | null; routedModel?: string | null };
  log: (step: string, row: Record<string, unknown>) => void;
}): void {
  for (const finding of capture.findings) {
    try {
      input.log("review.finding", {
        task_id: input.taskId, pr_url: input.prUrl, head_sha: input.headSha, review_decision_digest: input.decisionDigest,
        finding_id: finding.id, criterion_index: finding.criterion, category: finding.category, severity: finding.severity,
        mechanism: finding.mechanism, remedy: finding.remedy, anchor: finding.anchor, capture_state: finding.anchor.status,
        provider: input.provenance.provider, requested_model: input.provenance.requestedModel,
        served_model: input.provenance.servedModel, routed_model: input.provenance.routedModel ?? null,
        selection_assignment_id: input.provenance.selectionAssignmentId ?? null,
      });
    } catch { /* Telemetry failure cannot change a posted verdict or auto-merge. */ }
  }
}
