/**
 * A closing keyword in a pull request's body closes the pull request it names when the PR merges,
 * the same as it closes an issue.
 *
 * 2026-10-11: remudero-console #2035's body said "(root cause and fix: craigoley/remudero#10856)".
 * The fleet merged #2035 at 12:45:52Z, and GitHub closed core #10856, an open PR, two seconds
 * later. The close event's `closer` is #2035, and its actor is the fleet app only because the app
 * merged #2035. No fleet code closed #10856, so no ledger row said why.
 *
 * Before the fleet arms or merges a PR ({@link "./arm-auto-merge.js".attemptArm}), this reads the
 * PR's body, finds each closing-keyword reference, and asks GitHub which of them name an OPEN pull
 * request other than this one. Each such reference is rewritten in place, from "fix: owner/repo#N"
 * to "fix: PR owner/repo#N". The link stays, and GitHub no longer reads it as a closing reference.
 * Every rewrite writes one `pr.closing_reference_defused` ledger row naming the merging PR, the
 * referenced PR and the reason. A reference to an issue is left alone, because closing an issue is
 * what the keyword is for. The fleet closes its own leftover PRs explicitly, with a comment, never
 * through a keyword.
 */
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { step, type Steps } from "./git-push.js";

export const CLOSING_REFERENCE_DEFUSED_STEP = "pr.closing_reference_defused";

/** BACKSTOP: the most distinct references one body's guard reads from GitHub. Any past it are
 *  rewritten without a read, so a long body costs a bounded number of REST calls. */
export const CLOSING_REFERENCE_READ_BOUND = 20;

/** One closing-keyword reference found in a body. */
export interface ClosingReference {
  /** The matched text, e.g. `fix: craigoley/remudero#10856`. */
  text: string;
  index: number;
  keyword: string;
  separator: string;
  /** The reference exactly as written, e.g. `craigoley/remudero#10856` or `#12`. */
  reference: string;
  owner: string;
  repo: string;
  number: number;
}

/** GitHub's closing keywords. `\b` keeps `hotfix` and `prefixes` from matching. */
const KEYWORD = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
/** A colon and/or whitespace between the keyword and the reference. */
const SEPARATOR = String.raw`(\s*:\s*|\s+)`;
const REFERENCE =
  String.raw`(https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)` +
  String.raw`|([\w.-]+)\/([\w.-]+)#(\d+)` +
  String.raw`|#(\d+)` +
  String.raw`|GH-(\d+))\b`;

/** The `[start, end)` spans of fenced and inline code, where GitHub reads no references. */
function codeSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of body.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of body.matchAll(/`[^`\n]+`/g)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** Every closing-keyword reference in `body` outside code. `#N` and `GH-N` name `self`'s repo. */
export function closingReferencesInBody(body: string, self: { owner: string; repo: string }): ClosingReference[] {
  const spans = codeSpans(body);
  const out: ClosingReference[] = [];
  for (const m of body.matchAll(new RegExp(KEYWORD + SEPARATOR + REFERENCE, "gi"))) {
    if (spans.some(([start, end]) => m.index >= start && m.index < end)) continue;
    const [text, keyword, separator, reference] = m;
    const owner = m[4] ?? m[7] ?? self.owner;
    const repo = m[5] ?? m[8] ?? self.repo;
    const number = Number(m[6] ?? m[9] ?? m[10] ?? m[11]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    out.push({ text, index: m.index, keyword, separator, reference, owner, repo, number });
  }
  return out;
}

/** The rewrite: `fix: #12` → `fix: PR #12`, `Fixes #12` → `Fixes PR #12`. Idempotent, because a
 *  reference no longer follows the keyword directly. */
export function defusedText(ref: Pick<ClosingReference, "keyword" | "separator" | "reference">): string {
  return `${ref.keyword}${ref.separator.replace(/\s+$/, "")} PR ${ref.reference}`;
}

/** `body` with each of `refs` rewritten by {@link defusedText}. */
export function defuseClosingReferences(body: string, refs: readonly ClosingReference[]): string {
  let out = body;
  for (const ref of [...refs].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, ref.index) + defusedText(ref) + out.slice(ref.index + ref.text.length);
  }
  return out;
}

/** Why a reference was rewritten: GitHub said it is an open PR, or it could not be read. */
export type DefuseResolution = "open-pr" | "unreadable" | "over-read-bound";

export interface ClosingReferenceGuardResult {
  /** `clean`: nothing to rewrite. `defused`: the body was rewritten. `failed`: the body could not be
   *  read or rewritten, so merging could close an open PR. */
  state: "clean" | "defused" | "failed";
  defused: Array<{ reference: string; url: string; resolution: DefuseResolution }>;
  detail?: string;
}

export type ClosingReferenceRecorder = (row: Record<string, unknown>) => void;

/** The live ledger writer: a failed write is reported on stderr and never stops the merge path. */
export function recordClosingReferenceToLedger(getConfig: typeof loadConfig = loadConfig): ClosingReferenceRecorder {
  return (row) => {
    try {
      appendLedger(ledgerPathFor(getConfig()), { run_id: "closing-reference-guard", task_id: "SWEEP", ...row, step: CLOSING_REFERENCE_DEFUSED_STEP });
    } catch (error) {
      // The rewrite already happened; a lost row is reported here and never undoes or blocks it.
      console.warn(`closing-reference-guard: the ${CLOSING_REFERENCE_DEFUSED_STEP} row could not be written: ${String((error as Error)?.message ?? error)}`);
    }
  };
}

function prTarget(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(prUrl.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/**
 * Read `prUrl`'s body, rewrite each closing reference to another OPEN pull request, and record one
 * ledger row per rewrite. `read` and `write` are `gh` argv runners: the sync driver passes `ghJson`/
 * `ghExec`, the async driver their awaited forms.
 */
export function* closingReferenceGuardSteps(
  prUrl: string,
  read: (args: string[]) => unknown,
  write: (args: string[]) => unknown,
  record: ClosingReferenceRecorder,
): Steps<ClosingReferenceGuardResult> {
  const self = prTarget(prUrl);
  if (!self) return { state: "failed", defused: [], detail: `cannot resolve owner/repo/number from ${prUrl}` };
  let body: unknown;
  try {
    body = ((yield* step(() => read(["api", `repos/${self.owner}/${self.repo}/pulls/${self.number}`]))) as { body?: unknown } | undefined)?.body;
  } catch (e) {
    // Unread, the body may still name an open PR: "failed" withholds the arm, never "clean".
    return { state: "failed", defused: [], detail: `could not read this PR's body: ${String((e as Error)?.message ?? e)}` };
  }
  if (body === null || body === undefined || body === "") return { state: "clean", defused: [] };
  if (typeof body !== "string") return { state: "failed", defused: [], detail: "the PR's body was not readable text" };

  const refs = closingReferencesInBody(body, self).filter((r) => !(sameRepo(r, self) && r.number === self.number));
  if (refs.length === 0) return { state: "clean", defused: [] };

  // One read per distinct reference: is it an open pull request?
  const resolutions = new Map<string, DefuseResolution | "leave">();
  for (const ref of refs) {
    const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
    if (resolutions.has(key)) continue;
    if (resolutions.size >= CLOSING_REFERENCE_READ_BOUND) {
      resolutions.set(key, "over-read-bound");
      continue;
    }
    try {
      const row = (yield* step(() => read(["api", `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`]))) as
        | { pull_request?: unknown; state?: unknown }
        | undefined;
      resolutions.set(key, row?.pull_request && row.state === "open" ? "open-pr" : "leave");
    } catch {
      // Unknown whether it is an open PR: rewrite it, since leaving it could close one.
      resolutions.set(key, "unreadable");
    }
  }
  const toDefuse = refs.flatMap((ref) => {
    const resolution = resolutions.get(`${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`);
    return resolution && resolution !== "leave" ? [{ ref, resolution }] : [];
  });
  if (toDefuse.length === 0) return { state: "clean", defused: [] };

  const defused = toDefuse.map(({ ref, resolution }) => ({
    reference: ref.text,
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    resolution,
  }));
  const rowFor = (d: (typeof defused)[number], outcome: "defused" | "error", error?: string): Record<string, unknown> => ({
    step: CLOSING_REFERENCE_DEFUSED_STEP,
    pr_url: prUrl,
    pr_number: self.number,
    repo: `${self.owner}/${self.repo}`,
    referenced_pr_url: d.url,
    reference: d.reference,
    resolution: d.resolution,
    outcome,
    reason:
      `this PR's body names ${d.url} with a closing keyword ("${d.reference}"), and GitHub closes that pull request ` +
      `when this PR merges; the keyword was rewritten before the fleet armed or merged this PR`,
    ...(error ? { error: error.split("\n")[0] } : {}),
  });
  try {
    yield* step(() =>
      write(["api", "--method", "PATCH", `repos/${self.owner}/${self.repo}/pulls/${self.number}`, "-f", `body=${defuseClosingReferences(body as string, toDefuse.map((d) => d.ref))}`]),
    );
  } catch (e) {
    const error = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
    for (const d of defused) record(rowFor(d, "error", error));
    return { state: "failed", defused: [], detail: `could not rewrite this PR's body: ${error.split("\n")[0]}` };
  }
  for (const d of defused) record(rowFor(d, "defused"));
  return { state: "defused", defused };
}

// Bodies of armed PRs the guard already found clean, keyed by PR URL. A body that names only issues
// or closed PRs is otherwise re-read on every sweep pass for as long as its PR stays armed.
const cleanArmedBodies = new Map<string, string>();

/**
 * Whether an armed PR's listed body needs the guard again. attemptArm guards a body when the fleet
 * arms it, but GitHub merges an armed PR with whatever body it holds at that moment, so an edit made
 * after the arm can still name another open PR. A body the sweep did not list (`undefined`) needs it;
 * so does one that names any other PR or issue, unless the guard already found that same body clean.
 */
export function armedBodyNeedsGuard(prUrl: string, body: string | undefined): boolean {
  if (body === undefined) return true;
  const self = prTarget(prUrl);
  if (!self) return true;
  if (cleanArmedBodies.get(prUrl) === body) return false;
  return closingReferencesInBody(body, self).some((r) => !(sameRepo(r, self) && r.number === self.number));
}

/** Remember that the guard found `body` clean, so the next pass does not read it again. */
export function rememberCleanArmedBody(prUrl: string, body: string): void {
  if (cleanArmedBodies.size >= 256) cleanArmedBodies.clear(); // BACKSTOP on memory, not a control
  cleanArmedBodies.set(prUrl, body);
}
