import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap } from "yaml";
import { isPlacedTestPath } from "./plan.js";

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

/** The title with its own id and every NEW-n placeholder taken out, the brackets and separators they leave tidied.
 *  `undefined` when nothing is left, since an empty title is no repair. */
export function titleWithoutOwnId(title: string, taskId: string): string | undefined {
  const stripped = title
    .replace(TITLE_ID_TOKEN, (token) => (token === taskId || token.startsWith("NEW-") ? " " : token))
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+([,.;:)\]])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:;,.|/–—-]+/, "")
    .replace(/[\s:;,|/–—-]+$/, "")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
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
  return new RegExp(`(?<![\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w./-])`, "g");
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
 * - `ruling-verify` / `rule15-filing`: `verify: human`, only for that workflow-path task, since the draft lint refuses
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
      else if ((checks.has("ruling-verify") || checks.has("rule15-filing")) && workflow && verify !== "human") next = "human";
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
