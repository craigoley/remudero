import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap } from "yaml";
import { isPlacedTestPath, type Task } from "./plan.js";
import { rule15FilingViolation, rulingVerifyViolation } from "./task-linter.js";

/** While `state/DRAFT_AUTOFIX_OFF` exists the draft rung lints a drafted fragment as it came from the model, so every
 *  blocking violation spends a redraft as it did before the repair existed. */
export const DRAFT_AUTOFIX_OFF_FILE = "DRAFT_AUTOFIX_OFF";

export function draftAutofixOff(stateDir: string): boolean {
  return existsSync(join(stateDir, DRAFT_AUTOFIX_OFF_FILE));
}

/** What a repair needs from the checkout the draft is judged against. */
export interface DraftRepairFacts {
  /** True when the repo-relative path exists in the checkout or at origin/main. */
  pathExists: (path: string) => boolean;
  /** The slug-named new test the draft lint accepts for a task with this title and these files (placeTest's folder). */
  expectedTestPath: (title: string, files: readonly string[]) => string;
}

export interface DraftRepair {
  fragmentYaml: string;
  /** One `<fix>:<task id>` entry per change made; empty when the fragment came back unchanged. */
  repaired: string[];
}

/** The lint checks whose remedy this module can compute. Every other check is left to a redraft. */
export const AUTOFIXABLE_DRAFT_CHECKS: ReadonlySet<string> = new Set([
  "draft-placeholder-title", "draft-path-missing", "draft-test-unplaced", "shard-shape", "ruling-verify", "rule15-filing",
]);

const NEW_TEST_PATH = /^test\/[\w./-]+\.test\.[mc]?[jt]s$/;
const TITLE_ID_TOKEN = /\b(?:W\d+-T\d+|NEW-\d+)\b/g;

/** Separators beside a removed token: whitespace, `: ; , | /`, en and em dashes, and a hyphen only where it stands
 *  apart (` - `), so a flag such as `--dry-run` after the token keeps its dashes. */
const SEPARATORS_BEFORE = /(?:[\s:;,|/\u2013\u2014]|(?<=\s)-)*$/;
const SEPARATORS_AFTER = /^(?:[\s:;,|/\u2013\u2014]|-(?=\s))*/;

/** The title with its own id and every NEW-n placeholder taken out. Only the text around each removed token is tidied:
 *  the brackets that wrapped it alone and the separators beside it. The rest of the title is left as the model wrote it,
 *  so `[]`, `()` and `.env` elsewhere survive. A token joined to a word by an apostrophe (`NEW-1's`) has no clean
 *  removal, so the title comes back unchanged. `undefined` when nothing is left, since an empty title is no repair. */
export function titleWithoutOwnId(title: string, taskId: string): string | undefined {
  const removed = [...title.matchAll(TITLE_ID_TOKEN)].filter((m) => m[0] === taskId || m[0].startsWith("NEW-"));
  if (removed.length === 0) return title;
  if (removed.some((m) => /['\u2019]/.test(title[m.index! - 1] ?? "") || /['\u2019]/.test(title[m.index! + m[0].length] ?? ""))) return title;
  let out = title;
  for (const m of removed.reverse()) {
    let start = m.index!;
    let end = start + m[0].length;
    const open = /([([])\s*$/.exec(out.slice(0, start));
    const close = /^\s*([)\]])/.exec(out.slice(end));
    if (open && close && (open[1] === "(") === (close[1] === ")")) {
      start -= open[0].length;
      end += close[0].length;
    }
    const before = SEPARATORS_BEFORE.exec(out.slice(0, start))![0];
    const after = SEPARATORS_AFTER.exec(out.slice(end))![0];
    const kept = out.slice(0, start - before.length);
    const rest = out.slice(end + after.length);
    let join: string;
    if (kept.length === 0 || rest.length === 0) join = "";
    // Inside a bracket or before closing punctuation the separator would dangle: `(NEW-1, NEW-2)`, `[NEW-1].`.
    else if (/[([]$/.test(kept) || /^[,.;:!?)\]]/.test(rest)) join = "";
    else if (after.trim().length > 0) join = after;
    else if (before.trim().length > 0) join = before;
    else join = " ";
    out = kept + join + rest;
  }
  const stripped = out.trim();
  return stripped.length > 0 ? stripped : undefined;
}

/** True when THIS task, not merely some task of the fragment, raises a ruling-verify or rule15-filing the lint reported:
 *  the linter's own predicates on the task's own id, files, verify and status. */
function raisesRecordCheck(target: Record<string, unknown>, id: string, files: readonly string[], checks: ReadonlySet<string>): boolean {
  const task = { id, files: [...files], verify: target["verify"], status: target["status"] ?? "queued" } as unknown as Task;
  return (checks.has("ruling-verify") && rulingVerifyViolation(task) !== undefined)
    || (checks.has("rule15-filing") && rule15FilingViolation(task) !== undefined);
}

/** A task the fleet App cannot push, so the draft lint lets it stay `verify: human` (inbox.ts `declaresWorkflowPath`). */
function declaresWorkflowPath(files: readonly string[]): boolean {
  return files.some((f) => f.trim().replace(/^\.\//, "").startsWith(".github/workflows/"));
}

function stringOf(node: YAMLMap, key: string): string | undefined {
  const value: unknown = node.get(key);
  return typeof value === "string" ? value : undefined;
}

function pathPattern(path: string): RegExp {
  return new RegExp(`(?<![\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\.?[\\w/-])`, "g");
}

/**
 * Apply only the repairs a drafted fragment's own lint violations determine, never a guess. Each fixer runs only when a
 * violation with its check id is present, and re-derives the task it acts on from the fragment, so a repair of an
 * already-repaired fragment changes nothing:
 * - `draft-placeholder-title`: the title loses its own id and every NEW-n placeholder.
 * - `draft-path-missing` / `draft-test-unplaced` (or a title this pass changed, which moves the slug): the task's one
 *   new test path that is not the slug-named test placeTest computes is renamed to that path, in `files:`, in `design`
 *   and in every criterion that names it. Two such paths, or the computed path already declared, is no repair.
 * - `shard-shape` with a verify outside the enum: `auto`, as the draft prompt files every task, or `human` for a task
 *   that declares a `.github/workflows/` path, the one exception the prompt and `draft-human-ask-repeated` allow.
 * - `ruling-verify` / `rule15-filing`: `verify: human`, only for a workflow-path task that itself raises the check, since the draft lint refuses
 *   `verify: human` everywhere else and the remedy left is a split no script can choose.
 * Bytes outside the edited scalars are kept. A result that does not re-parse to exactly the intended change comes back
 * as the original fragment with nothing repaired.
 */
export function repairDraftedFragment(
  fragmentYaml: string,
  violations: ReadonlyArray<{ check: string }>,
  facts: DraftRepairFacts,
): DraftRepair {
  const unchanged: DraftRepair = { fragmentYaml, repaired: [] };
  const checks = new Set(violations.map((v) => v.check));
  if (![...checks].some((c) => AUTOFIXABLE_DRAFT_CHECKS.has(c))) return unchanged;
  const document = parseDocument(fragmentYaml);
  if (document.errors.length > 0 || !isSeq(document.contents)) return unchanged;
  const intended: unknown = document.toJS();
  if (!Array.isArray(intended)) return unchanged;

  const edits = new Map<Scalar, { text: string }>();
  const repaired: string[] = [];
  const replaceScalar = (node: Scalar, value: string, text: string, target: Record<string, unknown> | unknown[], key: string | number) => {
    edits.set(node, { text });
    (target as Record<string | number, unknown>)[key] = value;
  };
  const renameIn = (node: unknown, from: string, to: string, target: Record<string, unknown> | unknown[], key: string | number): boolean => {
    if (!isScalar(node) || typeof node.value !== "string" || !node.range) return false;
    const pattern = pathPattern(from);
    if (!pattern.test(node.value)) return false;
    const source = fragmentYaml.slice(node.range[0], node.range[1]);
    const value = node.value.replace(pathPattern(from), to);
    const inPlace = source.replace(pathPattern(from), to);
    replaceScalar(node, value, inPlace === source ? JSON.stringify(value) : inPlace, target, key);
    return true;
  };

  for (const [index, node] of document.contents.items.entries()) {
    const target = intended[index] as Record<string, unknown> | undefined;
    if (!isMap(node) || typeof target !== "object" || target === null) continue;
    const id = stringOf(node, "id") ?? "";
    const files = (target["files"] as unknown[] | undefined)?.filter((f): f is string => typeof f === "string") ?? [];
    let title = stringOf(node, "title") ?? "";

    const titleNode = node.get("title", true);
    if (checks.has("draft-placeholder-title") && isScalar(titleNode) && titleNode.range) {
      const next = titleWithoutOwnId(title, id);
      if (next !== undefined && next !== title) {
        replaceScalar(titleNode, next, JSON.stringify(next), target, "title");
        title = next;
        repaired.push(`title:${id}`);
      }
    }

    // A new title moves the slug, so the slug-named test it declared moves with it, or the title fix raises V2 itself.
    if (checks.has("draft-path-missing") || checks.has("draft-test-unplaced") || title !== (stringOf(node, "title") ?? "")) {
      const expected = facts.expectedTestPath(title, files);
      const design = stringOf(node, "design") ?? "";
      const creates = new Set([...design.matchAll(/^[ \t]*CREATES:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]));
      const misnamed = files.filter((path) => NEW_TEST_PATH.test(path) && path !== expected && !facts.pathExists(path)
        && (!creates.has(path) || !isPlacedTestPath(path)));
      const filesNode = node.get("files", true);
      if (misnamed.length === 1 && !files.includes(expected) && isSeq(filesNode)) {
        const from = misnamed[0];
        const filesTarget = target["files"] as unknown[];
        filesNode.items.forEach((item, i) => { renameIn(item, from, expected, filesTarget, i); });
        renameIn(node.get("design", true), from, expected, target, "design");
        const acceptance = node.get("acceptance", true);
        const acceptanceTarget = target["acceptance"];
        if (isSeq(acceptance) && Array.isArray(acceptanceTarget)) {
          acceptance.items.forEach((criterion, i) => {
            const criterionTarget = acceptanceTarget[i] as Record<string, unknown>;
            if (!isMap(criterion) || typeof criterionTarget !== "object" || criterionTarget === null) return;
            for (const field of ["claim", "proof"]) renameIn(criterion.get(field, true), from, expected, criterionTarget, field);
          });
        }
        repaired.push(`test-path:${id}`);
      }
    }

    const verifyNode = node.get("verify", true);
    const verify = target["verify"];
    if (isScalar(verifyNode) && verifyNode.range) {
      const workflow = declaresWorkflowPath(files);
      let next: string | undefined;
      if (checks.has("shard-shape") && verify !== "auto" && verify !== "human") next = workflow ? "human" : "auto";
      else if (workflow && verify !== "human" && raisesRecordCheck(target, id, files, checks)) next = "human";
      if (next !== undefined) {
        replaceScalar(verifyNode, next, next, target, "verify");
        repaired.push(`verify:${id}`);
      }
    }
  }

  if (edits.size === 0) return unchanged;
  let out = fragmentYaml;
  for (const [node, edit] of [...edits].sort((a, b) => b[0].range![0] - a[0].range![0])) {
    out = out.slice(0, node.range![0]) + edit.text + out.slice(node.range![1]);
  }
  const check = parseDocument(out);
  if (check.errors.length > 0 || JSON.stringify(check.toJS()) !== JSON.stringify(intended)) return unchanged;
  return { fragmentYaml: out, repaired };
}
