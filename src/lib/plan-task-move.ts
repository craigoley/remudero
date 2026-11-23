/**
 * W1-T13680 — `rmd move-task`: a recoverable two-repository move of one preview-admitted public task into the ops
 * catalog. Each run reads both mains at pinned commits and takes AT MOST ONE step:
 *
 *   WAIT      a plan-move- pull request is open in either repository: nothing else happens until it lands or closes.
 *   CONVERGE  an id both mains hold (a pending move), or one a public mover removal names that neither holds:
 *             - the ops copy equals the bound original and the public copy is unchanged and unowned: REMOVE opens the
 *               public removal pull request;
 *             - the public copy was amended, is claimed, has a run branch or an open pull request: ROLLBACK opens an
 *               ops pull request removing the ops copy, and the public copy stays;
 *             - neither main holds it while public history names its mover removal: RESTORE opens a public pull
 *               request restoring the bound original bytes at their path.
 *   PICK      nothing is pending: COPY opens one ops pull request adding the preview's candidate at its public path,
 *             byte for byte plus one `moved_from: remudero@<public commit>` line after its id line.
 *   COMPLETE  only ops holds an id with moved_from and public history names its removal: nothing opens, and the
 *             reservation ref is confirmed unchanged.
 *
 * W1-T14345: one step carries a batch. COPY adds every task of the preview's batch in one commit; CONVERGE takes every
 * id both mains hold at once, rolling back each owned one in one ops pull request, then removing the rest in one public
 * pull request (one Remudero-Moved-To receipt per removed record, the shape the review admits); RESTORE restores every
 * id neither holds in one. An id held (its ops copy differs, its reservation is gone) is left out rather than holding
 * the rest. A batch of one writes exactly the branch, commit, receipts and pull request a one-task move always wrote.
 *
 * The mover never deletes a record it has not first found byte-identical in the other catalog, never uses a run-
 * branch or a Remudero-Task line (so neither merge credits the task as built), and pushes, deletes and mints no
 * refs/rmd-id reservation. Any unreadable or incomplete read is UNKNOWN and takes no step. Without --apply it prints
 * the step it would take and writes nothing.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { systemClock, type Clock } from "./clock.js";
import { MOVED_FROM_VALUE, defaultGitRunnerAsync, withoutOneMovedFromLine } from "./plan.js";
import {
  MOVE_COPY_RECEIPT, PreviewUnknown, catalog, migrationOptions, readState, refs, selectPlanTaskMigration, unknown,
  type CatalogOriginal, type MigrationGraphqlReader, type MigrationOptions, type PreviewState,
} from "./plan-task-migration.js";
import { planPrPreflightAllows, planPrPreflightAtCommitAsync, ratifyPrCreateRestArgs, type PlanPrPreflightResult } from "./plan-pr-emitter.js";
import { ghJsonAsync } from "./github-transport.js";
import type { OpsCatalogBoundsIo } from "./ops-catalog-source.js";
import { taskIdFromRunBranch } from "./status.js";

export const MOVE_STEP = "plan.move.step";
export const MOVED_TO_TRAILER = "Remudero-Moved-To:";
export const MOVE_RESTORED_TRAILER = "Remudero-Move-Restored:";
export const MOVE_ROLLBACK_TRAILER = "Remudero-Move-Rollback:";
export const MOVE_RESERVATION_TRAILER = "Remudero-Move-Reservation:";
export const MOVE_BRANCH_PREFIX = "plan-move-";

export type MoveStep = "copy" | "remove" | "rollback" | "restore" | "wait" | "complete" | "none" | "held" | "unknown";
type Json = Record<string, unknown>;
type PullRequest = { title: string; body: string; head: string; base: string };
type Preflight = (repoDir: string, commit: string, pr: { title: string; body: string; headRef: string; codeRoot?: string; bodyProofRoot?: "plan" }) => Promise<PlanPrPreflightResult>;

export interface MovePorts {
  /** Every row this verb writes: one `plan.move.step` per step taken. Required: a mover never writes silently. */
  ledger: (row: { run_id: string; task_id: string; step: string } & Json) => void;
  /** The GraphQL reader the preview and the mover share; the CLI's own read by default. */
  graphql?: MigrationGraphqlReader;
  /** Open one pull request; GitHub's REST create by default. */
  createPull?: (repository: string, pr: PullRequest) => Promise<{ number: number; url: string }>;
  /** The plan-PR emitter's preflight over the exact commit about to be pushed. */
  preflight?: Preflight;
  /** The epoch milliseconds a mover branch is named with. */
  clock?: Clock;
  /** W1-T14345: the readings the ops catalog's derived bounds take; the live ones by default. */
  bounds?: OpsCatalogBoundsIo;
  print?: (line: string) => void;
}

/** What one public mover commit in history says it did. */
interface MoverEvent { kind: "removed" | "restored"; id: string; commit: string; path: string; blob: string; reservation?: string }
type StepKind = Exclude<MoveStep, "wait" | "complete" | "none" | "held" | "unknown">;
/** One task's part of a step: the path it writes (`text`) or removes (no `text`), and the receipt lines it adds. */
interface Planned {
  step: StepKind;
  id: string; repository: "public" | "ops"; path: string; blob?: string; text?: string; reason?: string;
  title: string; message: string; evidence: Json;
}
/** W1-T14345: one step's whole write: one commit of every member's change, one branch, one pull request. */
interface PlannedStep { step: StepKind; repository: "public" | "ops"; members: Planned[]; title: string; message: string }

/** A batch of one is the member's own step, byte for byte; a batch names its count and carries every member's lines. */
function stepOf(members: Planned[]): PlannedStep {
  const [first] = members as [Planned, ...Planned[]];
  if (members.length === 1) return { step: first.step, repository: first.repository, members, title: first.title, message: first.message };
  const lines = (m: Planned) => m.message.slice(m.message.lastIndexOf("\n\n") + 2);
  const what: Record<StepKind, [string, string]> = {
    copy: [`move ${members.length} tasks into the ops catalog`, "Each public record, byte for byte, plus one moved_from line after its id line."],
    remove: [`move ${members.length} tasks to the ops catalog`, "The ops catalog holds each of these records byte for byte plus its moved_from line."],
    rollback: [`roll back the move of ${members.length} tasks into the ops catalog`, "Each public copy is owned, so it stays and its ops copy is removed."],
    restore: [`restore ${members.length} tasks after an interrupted move`, "Neither catalog holds these records, and public history names each one's mover removal."],
  };
  const [subject, prose] = what[first.step];
  return { step: first.step, repository: first.repository, members, title: `chore(plan): ${subject}`,
    message: `chore(plan): ${subject}\n\n${prose}\n\n${members.map(lines).join("")}` };
}

const defaultCreatePull = async (repository: string, pr: PullRequest): Promise<{ number: number; url: string }> => {
  const [owner, repo] = repository.split("/");
  const row = await ghJsonAsync(ratifyPrCreateRestArgs(owner!, repo!, pr)) as { number?: unknown; html_url?: unknown } | null;
  if (typeof row?.number !== "number" || typeof row.html_url !== "string") throw new Error("pull_request_unconfirmed");
  return { number: row.number, url: row.html_url };
};
const defaultPreflight: Preflight = (repoDir, commit, pr) => planPrPreflightAtCommitAsync(repoDir, commit, pr);

/** The plan reader's own Git runner (one `git -C <root>` spawn with optional stdin); both roots are operator checkouts. */
const git = (root: string, args: readonly string[], stdin?: string): Promise<string> => defaultGitRunnerAsync(root)([...args], stdin);
const blobOf = (text: string): string => { const b = Buffer.from(text); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };

/** The original bytes plus one moved_from line after the id line, or unknown when the record has no plain id line. */
export function withMovedFromLine(original: string, id: string, publicCommit: string): string {
  const lines = original.split(/(?<=\n)/);
  // The id line is matched as text, never compiled into a RegExp, so no character of the id can act as a pattern.
  const isIdLine = (line: string): boolean => {
    const body = line.replace(/\r?\n?$/, "");
    return body.startsWith("- id:") && body.slice("- id:".length).replace(/^[ \t]*/, "").replace(/[ \t]*$/, "") === id;
  };
  const at = lines.findIndex(isIdLine);
  const indent = /^([ \t]+)\S/.exec(lines[at + 1] ?? "")?.[1];
  if (at < 0 || indent === undefined) return unknown("copy_shape");
  const copy = [...lines.slice(0, at + 1), `${indent}moved_from: remudero@${publicCommit}\n`, ...lines.slice(at + 1)].join("");
  const parsed: unknown = parseYaml(copy, { logLevel: "silent" });
  const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] as Json : undefined;
  return entry?.id === id && entry.moved_from === `remudero@${publicCommit}` && withoutOneMovedFromLine(copy) === original ? copy : unknown("copy_shape");
}

/** The trailer lines the mover writes into public history: the newest event per id. */
async function moverHistory(root: string, commit: string): Promise<Map<string, MoverEvent>> {
  const out = await git(root, ["log", "--format=%H%x1f%B%x1e", "--extended-regexp", `--grep=^(${MOVED_TO_TRAILER}|${MOVE_RESTORED_TRAILER})`, commit]);
  const latest = new Map<string, MoverEvent>();
  for (const entry of out.split("\x1e")) {
    const [sha, body] = entry.trim().split("\x1f");
    if (!sha || body === undefined) continue;
    const reservations = new Map([...body.matchAll(/^Remudero-Move-Reservation: (\S+) ([0-9a-f]{40})$/gm)].map(m => [m[1]!, m[2]!]));
    for (const m of body.matchAll(/^Remudero-Moved-To: \S+@[0-9a-f]{40} (\S+) path=(\S+) blob=([0-9a-f]{40})$/gm)) {
      if (!latest.has(m[1]!)) latest.set(m[1]!, { kind: "removed", id: m[1]!, commit: sha, path: m[2]!, blob: m[3]!, reservation: reservations.get(m[1]!) });
    }
    for (const m of body.matchAll(/^Remudero-Move-Restored: (\S+) path=(\S+) blob=([0-9a-f]{40})/gm)) {
      if (!latest.has(m[1]!)) latest.set(m[1]!, { kind: "restored", id: m[1]!, commit: sha, path: m[2]!, blob: m[3]! });
    }
  }
  return latest;
}

/** What owns the public copy right now: a claim, a run branch, or an open pull request on the id or its record. */
function publicOwner(id: string, path: string, remote: Map<string, string>, open: Json[]): string | undefined {
  if (remote.has(`refs/rmd-dispatch/${id}`)) return "claimed";
  if ([...remote.keys()].some(ref => ref.startsWith("refs/heads/") && taskIdFromRunBranch(ref.slice(11)) === id)) return "run_branch";
  const files = (pr: Json) => (pr.files as { nodes?: Json[] } | undefined)?.nodes ?? [];
  if (open.some(pr => taskIdFromRunBranch(String(pr.headRefName)) === id || String(pr.body).split(/\r?\n/).includes(`Remudero-Task: ${id}`) ||
    files(pr).some(file => file.path === path))) return "open_pull_request";
  return undefined;
}

async function readBytes(root: string, spec: string): Promise<string | undefined> {
  const kind = await git(root, ["cat-file", "-t", spec]).then(out => out.trim(), () => undefined);
  return kind === "blob" ? git(root, ["cat-file", "blob", spec]) : undefined;
}

/** The tree `treeish` names with `path` set to `blob`, or removed when `blob` is undefined, built with mktree only. */
async function treeWith(root: string, treeish: string, path: string, blob: string | undefined): Promise<string> {
  const edit = async (tree: string | undefined, parts: string[]): Promise<string | undefined> => {
    const entries = tree === undefined ? [] : (await git(root, ["ls-tree", "-z", tree])).split("\0").filter(Boolean);
    const [name, ...rest] = parts as [string, ...string[]];
    const kept = entries.filter(entry => entry.slice(entry.indexOf("\t") + 1) !== name);
    const current = entries.find(entry => entry.slice(entry.indexOf("\t") + 1) === name);
    let child: string | undefined;
    if (rest.length === 0) child = blob === undefined ? undefined : `100644 blob ${blob}\t${name}`;
    else {
      const sub = await edit(current === undefined ? undefined : /^040000 tree ([0-9a-f]{40})\t/.exec(current)?.[1] ?? unknown("tree_shape"), rest);
      child = sub === undefined ? undefined : `040000 tree ${sub}\t${name}`;
    }
    const next = [...kept, ...(child === undefined ? [] : [child])];
    return next.length === 0 ? undefined : (await git(root, ["mktree", "-z"], next.map(entry => `${entry}\0`).join(""))).trim();
  };
  return (await edit(treeish, path.split("/"))) ?? unknown("tree_shape");
}

async function commitOn(root: string, parent: string, tree: string, message: string): Promise<string> {
  // A host with no git identity (a CI runner) still records the mover as the author; a configured identity wins.
  // `git config` exits 1 for an unset key; any unread identity falls back to the named mover identity below.
  const named = await git(root, ["config", "user.email"]).then(email => email.trim() !== "", () => false);
  const identity = named ? [] : ["-c", "user.name=rmd move-task", "-c", "user.email=move-task@remudero.invalid"];
  return (await git(root, [...identity, "commit-tree", tree, "-p", parent, "-F", "-"], message)).trim();
}

function plannedConverge(o: MigrationOptions, state: PreviewState, publicRefs: Map<string, string>, id: string,
  pub: CatalogOriginal, opsCopy: CatalogOriginal, bound: { text: string; blob: string; commit: string }): Planned | { held: string } {
  if (withoutOneMovedFromLine(opsCopy.text) !== bound.text) return { held: "ops_copy_differs" };
  if (opsCopy.path !== pub.path) return { held: "path_differs" };
  const amended = pub.blob !== bound.blob ? "amended" : undefined;
  const owner = amended ?? publicOwner(id, pub.path, publicRefs, state.open);
  const evidence = { boundCommit: bound.commit, boundBlob: bound.blob, publicBlob: pub.blob, opsBlob: opsCopy.blob, owner: owner ?? null };
  if (owner !== undefined) {
    return { step: "rollback", id, repository: "ops", path: opsCopy.path, reason: owner, evidence,
      title: `chore(plan): roll back the move of ${id} into the ops catalog`,
      message: `chore(plan): roll back the move of ${id} into the ops catalog\n\nThe public copy is ${owner}, so it stays and this ops copy is removed.\n\n${MOVE_ROLLBACK_TRAILER} ${id} path=${opsCopy.path} reason=${owner}\n` };
  }
  const reservation = publicRefs.get(`refs/rmd-id/${id}`);
  if (reservation === undefined) return { held: "reservation_absent" };
  return { step: "remove", id, repository: "public", path: pub.path, blob: bound.blob, evidence: { ...evidence, reservation },
    title: `chore(plan): move ${id} to the ops catalog`,
    message: `chore(plan): move ${id} to the ops catalog\n\nThe ops catalog holds this record byte for byte plus its moved_from line.\n\n` +
      `${MOVED_TO_TRAILER} ${o.opsRepo}@${o.opsCommit} ${id} path=${pub.path} blob=${bound.blob}\n${MOVE_RESERVATION_TRAILER} ${id} ${reservation}\n` };
}

/** The whole transaction, one step per run. Exits 0 when the read completed (a step, a wait, a hold or nothing to do),
 *  1 when the evidence was unknown or a write failed, 2 on bad usage. */
export async function movePlanTask(args: readonly string[], ports: MovePorts): Promise<number> {
  const print = ports.print ?? ((line: string) => console.log(line));
  const apply = args.includes("--apply");
  const o = migrationOptions(args.filter(arg => arg !== "--apply"));
  if (!o || args.filter(arg => arg === "--apply").length > 1) { print(JSON.stringify({ step: "unknown", reason: "usage" })); return 2; }
  const reader = ports.graphql, clock = ports.clock ?? systemClock;
  const report = (step: MoveStep, extra: Json = {}): number => {
    print(JSON.stringify({ step, applied: false, publicCommit: o.publicCommit, opsCommit: o.opsCommit, ...extra }));
    return step === "unknown" ? 1 : 0;
  };
  let planned: PlannedStep;
  try {
    const publicRefs = await refs(o.publicRoot, o.publicRepo), opsRefs = await refs(o.opsRoot, o.opsRepo);
    const pub = await catalog(o.publicRoot, o.publicCommit), ops = await catalog(o.opsRoot, o.opsCommit, true);
    const state = await readState(o, publicRefs, opsRefs, { reader, movers: true });
    const open = [...(state.publicMoves ?? []).map(pr => ({ repository: o.publicRepo, number: pr.number, head: pr.headRefName })),
      ...(state.opsMoves ?? []).map(pr => ({ repository: o.opsRepo, number: pr.number, head: pr.headRefName }))];
    if (open.length > 0) return report("wait", { openMovePullRequests: open });
    const history = await moverHistory(o.publicRoot, o.publicCommit);
    const shared = ops.plan.tasks.filter(task => pub.plan.byId.has(task.id)).map(task => task.id).sort();
    // W1-T14345: every pending id at once. An owned one is rolled back first, then the rest removed together; a held
    // one is left out, and holds the step only when nothing else can converge.
    const converge = async (): Promise<PlannedStep | { held: string; id: string } | undefined> => {
      const held: Array<{ held: string; id: string }> = [];
      const steps: Planned[] = [];
      for (const id of shared) {
        const moved = ops.plan.byId.get(id)!.moved_from;
        const source = moved === undefined ? undefined : MOVED_FROM_VALUE.exec(moved)?.[1];
        if (source === undefined) return unknown("catalog_conflict");
        const opsCopy = ops.originals.get(id)!, pubCopy = pub.originals.get(id)!;
        const text = await readBytes(o.publicRoot, `${source}:${opsCopy.path}`);
        if (text === undefined) { held.push({ held: "bound_original_unreadable", id }); continue; }
        const step = plannedConverge(o, state, publicRefs, id, pubCopy, opsCopy, { text, blob: blobOf(text), commit: source });
        if ("held" in step) held.push({ ...step, id }); else steps.push(step);
      }
      const rollbacks = steps.filter(step => step.step === "rollback");
      if (steps.length > 0) return stepOf(rollbacks.length > 0 ? rollbacks : steps);
      if (held.length > 0) return held[0];
      const restores: Planned[] = [];
      for (const event of history.values()) {
        if (event.kind !== "removed" || pub.plan.byId.has(event.id) || ops.plan.byId.has(event.id)) continue;
        // A trailer is not evidence by itself: its commit must really leave the path empty.
        if (await readBytes(o.publicRoot, `${event.commit}:${event.path}`) !== undefined) continue;
        const text = await readBytes(o.publicRoot, event.blob);
        if (text === undefined || blobOf(text) !== event.blob) { held.push({ held: "bound_original_unreadable", id: event.id }); continue; }
        restores.push({ step: "restore", id: event.id, repository: "public", path: event.path, blob: event.blob, text,
          evidence: { removalCommit: event.commit, boundBlob: event.blob, heldBy: "neither" },
          title: `chore(plan): restore ${event.id} after an interrupted move`,
          message: `chore(plan): restore ${event.id} after an interrupted move\n\nNeither catalog holds this record, and public history names its mover removal.\n\n` +
            `${MOVE_RESTORED_TRAILER} ${event.id} path=${event.path} blob=${event.blob} removal=${event.commit}\n` });
      }
      return restores.length > 0 ? stepOf(restores) : held[0];
    };
    const step = await converge();
    if (step !== undefined && "held" in step) return report("held", { id: step.id, reason: step.held });
    // COMPLETE evidence: every removal only ops now holds, with its reservation ref unchanged since the removal.
    const completed = [...history.values()].filter(event => event.kind === "removed" && !pub.plan.byId.has(event.id) && ops.plan.byId.get(event.id)?.moved_from !== undefined)
      .map(event => ({ id: event.id, removalCommit: event.commit, reservation: publicRefs.get(`refs/rmd-id/${event.id}`) ?? null,
        reservationUnchanged: event.reservation !== undefined && publicRefs.get(`refs/rmd-id/${event.id}`) === event.reservation }));
    if (step !== undefined) planned = step;
    else {
      const selection = await selectPlanTaskMigration(o, reader, ports.bounds);
      if (selection.candidate === undefined) return report(completed.length > 0 ? "complete" : "none", { completed, refused: selection.refused.length });
      const members: Planned[] = [];
      for (const candidate of selection.batch) {
        const id = String(candidate.id), path = String(candidate.sourcePath), original = String(candidate.yaml);
        if (await readBytes(o.opsRoot, `${o.opsCommit}:${path}`) !== undefined) return unknown("ops_path_taken");
        const reservation = publicRefs.get(`refs/rmd-id/${id}`) ?? unknown("reservation_absent");
        const text = withMovedFromLine(original, id, o.publicCommit);
        members.push({ step: "copy", id, repository: "ops", path, text, blob: String(candidate.sourceBlob),
          evidence: { sourceCommit: o.publicCommit, sourceBlob: candidate.sourceBlob, reservation },
          title: `chore(plan): move ${id} into the ops catalog`,
          message: `chore(plan): move ${id} into the ops catalog\n\nThe public record, byte for byte, plus one moved_from line after its id line.\n\n` +
            `${MOVE_COPY_RECEIPT} ${id} path=${path} blob=${String(candidate.sourceBlob)} from=remudero@${o.publicCommit}\n${MOVE_RESERVATION_TRAILER} ${id} ${reservation}\n` });
      }
      planned = stepOf(members);
    }
    const [lead] = planned.members as [Planned, ...Planned[]];
    const batched = planned.members.length > 1;
    // A batch of one prints and records exactly what a one-task step always did; a batch adds every member's id.
    const ids = batched ? { ids: planned.members.map(m => m.id) } : {};
    // A copy's evidence also names every completed move, once per step.
    const evidence = { ...(batched ? { tasks: planned.members.map(m => ({ id: m.id, path: m.path, reason: m.reason ?? null, ...m.evidence })) } : lead.evidence),
      ...(planned.step === "copy" ? { completed } : {}) };
    if (!apply) return report(planned.step, { id: lead.id, ...ids, would: true, repository: planned.repository, path: lead.path, reason: lead.reason ?? null, evidence });
    // ── Write: one commit, the emitter's preflight, one branch push, one pull request, one ledger row. ──
    const repository = planned.repository === "public" ? o.publicRepo : o.opsRepo;
    const root = planned.repository === "public" ? o.publicRoot : o.opsRoot;
    const parent = planned.repository === "public" ? o.publicCommit : o.opsCommit;
    const base = planned.repository === "public" ? state.publicBranch : state.opsBranch;
    let tree = `${parent}^{tree}`;
    for (const member of planned.members) {
      const blob = member.text === undefined ? undefined : (await git(root, ["hash-object", "-w", "--stdin"], member.text)).trim();
      tree = await treeWith(root, tree, member.path, blob);
    }
    const commit = await commitOn(root, parent, tree, planned.message);
    // A one-task step names its task, which the review requires of a single receipt; a batch's branch names its shape.
    const branch = `${MOVE_BRANCH_PREFIX}${batched ? "batch" : lead.id}-${clock.now()}`;
    const body = `${planned.message.slice(planned.message.indexOf("\n\n") + 2)}`;
    const verdict = await (ports.preflight ?? defaultPreflight)(root, commit, { title: planned.title, body, headRef: branch,
      ...(planned.repository === "ops" ? { codeRoot: o.publicRoot, bodyProofRoot: "plan" as const } : {}) });
    // A preflight check that could not run is reported, never refusing (the emitter's rule); the row names it.
    const row = (outcome: string, extra: Json = {}) => ports.ledger({ run_id: branch, task_id: lead.id, step: MOVE_STEP, move_step: planned.step, outcome,
      repository, public_commit: o.publicCommit, ops_commit: o.opsCommit, commit, preflight_unreadable: verdict.unreadable.map(f => f.check),
      ...(batched ? { task_ids: ids.ids } : {}), ...extra });
    if (!planPrPreflightAllows(verdict, { lane: "move-task", branch })) {
      row("preflight_refused");
      print(JSON.stringify({ step: planned.step, applied: false, id: lead.id, ...ids, outcome: "preflight_refused", failures: verdict.failures.map(f => f.check) }));
      return 1;
    }
    let pr: { number: number; url: string };
    let outcome = "push_failed";
    try {
      await git(root, ["push", "--quiet", `https://github.com/${repository}.git`, `${commit}:refs/heads/${branch}`]);
      outcome = "pull_request_failed";
      pr = await (ports.createPull ?? defaultCreatePull)(repository, { title: planned.title, body, head: branch, base });
    } catch (error) {
      // Either half leaves no pull request: the next run reads the same state and takes the same step on a new branch.
      void error;
      row(outcome);
      print(JSON.stringify({ step: planned.step, applied: false, id: lead.id, ...ids, outcome }));
      return 1;
    }
    row("opened", { pull_request: pr.number });
    print(JSON.stringify({ step: planned.step, applied: true, id: lead.id, ...ids, repository, branch, commit, pullRequest: pr.number, url: pr.url,
      publicCommit: o.publicCommit, opsCommit: o.opsCommit, reason: lead.reason ?? null, evidence }));
    return 0;
  } catch (error) {
    // Raw Git/API/parser errors can carry private paths or record bytes: report the named reason only.
    return report("unknown", { reason: error instanceof PreviewUnknown ? error.reason : "unreadable_evidence" });
  }
}
