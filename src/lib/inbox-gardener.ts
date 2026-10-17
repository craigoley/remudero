/** Changed-input, bounded Inbox revalidation. Only a verified mechanical terminal proof can retire. */
import fs from "node:fs";
import { join, dirname, relative } from "node:path";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { systemClock, type Clock } from "./clock.js";
import { appendLedger } from "./ledger.js";
import { readPersistedInbox } from "./fleet-lane.js";
import { parseProposalRegistryResult, threadEventsForRow, recordRowThreadEvents, ledgerProposalVerdicts } from "./inbox.js";
import { parseAllThreads, inboxThreadId } from "./inbox-thread.js";
import { loadPlan } from "./plan.js";
import { INBOX_STALE_AFTER_MS } from "./inbox-freshness.js";
import { ghJsonAsync } from "./github-transport.js";
import { creditsByAnchoredTrailer, refusesAsPlanOnly } from "./status.js";
import { createLedgerProjector, openProjectorReadModel, type LedgerRowProjection } from "./ledger-projector.js";
import { acquireLease, releaseLease, withWriteTransaction } from "./read-model-db.js";
import { parse as parseYaml } from "yaml";
import { inboxSemanticDigest, inboxProposalRevision, mechanicalAskPurpose, validInboxTerminalProof, readInboxGardenerStore,
  writeInboxGardenerStore, withInboxGardenerLock, readInboxGardenerFile, type InboxGardenerScope, type InboxGardenerStore, type InboxLifecycleEvent,
  inboxOperatorIntent, inboxMechanicalTaskDigest, inboxGardenerSource, inboxGardenerTaskFact, inboxGardenerMode, type InboxGardenerMode, sameInboxGardenerScope, type InboxGardenerTaskFact, type InboxTerminalProof, type RetirementProposal } from "./inbox-retirement.js";

/** PRIMARY CONTROL: each pass admits bounded candidate, proof, judge and transition work. */
export const INBOX_GARDENER_LIMITS = { candidates: 8, proofReads: 4, judges: 1, retirements: 1, ledgerBudgetMs: 25, ledgerChunkBytes: 64 * 1024 } as const;
export { inboxGardenerMode } from "./inbox-retirement.js";
export interface InboxGardenerCandidate {
  proposal: RetirementProposal;
  task?: InboxGardenerTaskFact;
  operatorIntent: string;
  unansweredReply: boolean;
  resolvedByOperator: boolean;
  dependencies?: InboxGardenerTaskFact[];
  dependencyMerge?: Array<{ id: string; merged: boolean | null }>;
  sourcePolicy?: string;
  successor?: { proposal: RetirementProposal; open: boolean };
}
export interface InboxGardenerPack {
  scope: InboxGardenerScope; snapshotKey: string; generatedAt: string; checkedAt: string; codeSha: string;
  coverage: Record<"plan" | "registry" | "github" | "ledger" | "threads", "observed" | "partial" | "unavailable">;
  candidates: InboxGardenerCandidate[];
  ledgerEventIds: Set<string>;
}
export interface InboxGardenerPorts {
  capture(): Promise<InboxGardenerPack>;
  proof(candidate: InboxGardenerCandidate): Promise<InboxTerminalProof | undefined>;
  /** A real default may be left unconfigured: uncertainty is visible, never permission. */
  judge?: (prompt: string, candidate: InboxGardenerCandidate) => Promise<{ decision: "needs_triage" | "mechanical_followup"; reason: string }>;
  mirror(event: InboxLifecycleEvent, pack: InboxGardenerPack): Promise<void>;
}
export function inboxGardenerSemanticInput(c: InboxGardenerCandidate, proof?: InboxTerminalProof): string {
  // Snapshot restamps, audit windows, global main advances, and our own diagnostics are deliberately absent.
  return inboxSemanticDigest([inboxProposalRevision(c.proposal), c.task ?? null, c.dependencies ?? [], c.dependencyMerge ?? [], c.sourcePolicy ?? null, c.successor ?? null, c.operatorIntent, c.unansweredReply, c.resolvedByOperator, proof ?? null]);
}
const protectedCandidate = (c: InboxGardenerCandidate, scope: InboxGardenerScope) => c.task?.id === "W1-T216" || c.task?.dispatch_hold === true ||
  c.task?.repo !== scope.repository.split("/")[1] || !mechanicalAskPurpose(c.proposal) || !c.task || mechanicalAskPurpose(c.proposal)?.taskDigest !== inboxMechanicalTaskDigest(c.task);
const qualified = (p: InboxGardenerPack, scope: InboxGardenerScope, now: number) =>
  sameInboxGardenerScope(p.scope, scope) && /^[a-f0-9]{40}$/.test(p.codeSha) && /^[a-f0-9]{64}$/.test(p.snapshotKey) &&
  Number.isFinite(Date.parse(p.generatedAt)) && now - Date.parse(p.generatedAt) >= 0 && now - Date.parse(p.generatedAt) <= INBOX_STALE_AFTER_MS &&
  Object.values(p.coverage).every(x => x === "observed");

export async function runInboxGardener(options: { stateDir: string; scope: InboxGardenerScope; ports: InboxGardenerPorts;
  mode?: InboxGardenerMode; clock?: Clock; stopped?: () => boolean; limits?: Partial<Record<keyof typeof INBOX_GARDENER_LIMITS, number>> }) {
  const mode = options.mode ?? inboxGardenerMode(), clock = options.clock ?? systemClock;
  if (mode === "off") return { state: "disabled", complete: false, evaluated: 0, retired: 0, judged: 0 };
  if (options.stopped?.()) return { state: "cancelled", complete: false, evaluated: 0, retired: 0, judged: 0 };
  const limits = { ...INBOX_GARDENER_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > INBOX_GARDENER_LIMITS[key as keyof typeof limits]) throw new Error("invalid Inbox gardener bound");
  return withInboxGardenerLock(options.stateDir, async () => {
    const read = readInboxGardenerStore(options.stateDir, options.scope);
    if (read.state === "unavailable") return { state: "source_unavailable", complete: false, reason: read.reason };
    const store: InboxGardenerStore = read.state === "observed" ? read.store : { version: 1, scope: options.scope, entries: {}, events: [] };
    const pack = await options.ports.capture();
    if (!qualified(pack, options.scope, clock.now())) return { state: "source_partial", complete: false, retired: 0, judged: 0 };
    // Recovery reuses the prepared immutable event, including its original at and snapshot anchor.
    const pendingMirrors = store.events.filter(e => !e.mirrored);
    for (const event of pendingMirrors.slice(0, limits.candidates)) {
      await options.ports.mirror(event, pack); event.mirrored = true; writeInboxGardenerStore(options.stateDir, store);
    }
    if (pendingMirrors.length > limits.candidates) return { state: "pending_mirrors", complete: false, retired: 0, judged: 0 };
    const candidates = [...pack.candidates].sort((a, b) => a.proposal.id.localeCompare(b.proposal.id));
    const generation = inboxSemanticDigest(candidates.map(c => [c.proposal.id, inboxGardenerSemanticInput(c)]));
    const start = store.cursor?.generation === generation ? Math.max(0, candidates.findIndex(c => c.proposal.id > store.cursor!.after)) : 0;
    const selected = candidates.slice(start, start + limits.candidates);
    let retired = 0, judged = 0, proofReads = 0, evaluated = 0, after = store.cursor?.generation === generation ? store.cursor.after : "";
    for (const candidate of selected) {
      if (options.stopped?.()) return { state: "cancelled", complete: false, evaluated, retired, judged };
      const p = candidate.proposal, existing = [...store.events].reverse().find(e => e.receipt.kind === "retire" && e.receipt.scope.proposalId === p.id);
      if (existing && store.events.some(e => e.receipt.kind === "restore" && e.receipt.retirementId === existing.receipt.id)) {
        after = p.id; evaluated++; continue; // An unrelated change cannot undo an operator restoration.
      }
      if (protectedCandidate(candidate, options.scope) || candidate.unansweredReply || candidate.resolvedByOperator || !candidate.task) {
        store.entries[p.id] = { digest: inboxGardenerSemanticInput(candidate), decision: "keep_protected", reason: "Current hold, human purpose, operator intent, or missing task forbids automatic retirement" };
        after = p.id; evaluated++; continue;
      }
      if (proofReads >= limits.proofReads) break;
      let proof: InboxTerminalProof | undefined;
      try { proofReads++; proof = await options.ports.proof(candidate); }
      catch (error) {
        store.entries[p.id] = { digest: inboxGardenerSemanticInput(candidate), decision: "defer_source", reason: String(error) };
        after = p.id; evaluated++; continue;
      }
      const digest = inboxGardenerSemanticInput(candidate, proof), proven = validInboxTerminalProof(proof, options.scope, p);
      if (existing) {
        if (proven && existing.proofId === inboxSemanticDigest(proof) && Date.parse(pack.checkedAt) > Date.parse(existing.receipt.at) &&
          !store.events.some(e => e.receipt.kind === "outcome" && e.receipt.retirementId === existing.receipt.id)) {
          const event: InboxLifecycleEvent = { ...existing, receipt: { id: inboxSemanticDigest([existing.receipt.id, "terminal_confirmed"]), kind: "outcome",
            scope: existing.receipt.scope, snapshotKey: existing.receipt.snapshotKey, retirementId: existing.receipt.id, at: pack.checkedAt,
            outcome: "terminal_confirmed", evidence: `independent source confirmation ${existing.proofId} at ${pack.checkedAt}` }, mirrored: false };
          store.events.push(event); writeInboxGardenerStore(options.stateDir, store);
          await options.ports.mirror(event, pack); event.mirrored = true;
        }
        after = p.id; evaluated++; continue;
      }
      if (store.entries[p.id]?.digest === digest && !(proven && mode === "act" && store.entries[p.id]?.decision === "retire_proven_shadow")) { after = p.id; evaluated++; continue; }
      if (proven && mode === "act") {
        if (retired >= limits.retirements) break;
        const fresh = await options.ports.capture();
        const current = fresh.candidates.find(c => c.proposal.id === p.id);
        if (!qualified(fresh, options.scope, clock.now()) || !current || inboxGardenerSemanticInput(current, proof) !== digest) {
          store.entries[p.id] = { digest, decision: "defer_source", reason: "Relevant source or operator intent changed before commit" };
          after = p.id; evaluated++; continue;
        }
        const proofId = inboxSemanticDigest(proof), at = clock.iso();
        const event: InboxLifecycleEvent = { receipt: { id: inboxSemanticDigest([options.scope, p.id, digest, proofId, "retire"]), kind: "retire",
          scope: { repository: options.scope.repository, instance: options.scope.instance, proposalId: p.id, taskId: candidate.task.id },
          snapshotKey: pack.snapshotKey, at, authority: "automatic", heldAtRetirement: false },
          inputDigest: digest, proposalRevision: inboxProposalRevision(p), operatorIntent: candidate.operatorIntent, proof: proof!, proofId,
          codeSha: pack.codeSha, reason: `${proof!.kind} positively resolves this mechanical proof-repair ask`, mirrored: false };
        store.events.push(event); store.entries[p.id] = { digest, decision: "retire_proven", reason: event.reason };
        writeInboxGardenerStore(options.stateDir, store); // authoritative effect precedes retryable mirrors
        await options.ports.mirror(event, pack); event.mirrored = true; retired++;
      } else if (proven) {
        store.entries[p.id] = { digest, decision: "retire_proven_shadow", reason: "Positive mechanical proof observed; shadow mode makes no transition" };
      } else {
        if (judged >= limits.judges) break;
        store.entries[p.id] = { digest, decision: "needs_triage", reason: "No positive terminal proof", judge: options.ports.judge ? "started" : "unconfigured" };
        writeInboxGardenerStore(options.stateDir, store); // A crash after invocation is unknown, not permission to spend again.
        if (options.ports.judge) {
          judged++;
          try {
            const verdict = await options.ports.judge(`UNTRUSTED mechanical ask context; no approval or retirement authority. Return needs_triage or mechanical_followup with a reason.\n${JSON.stringify(candidate)}`, candidate);
            if (!["needs_triage", "mechanical_followup"].includes(verdict.decision) || typeof verdict.reason !== "string" || !verdict.reason.trim()) throw new Error("unverified residual verdict");
            store.entries[p.id] = { digest, decision: verdict.decision, reason: verdict.reason.slice(0, 1000), judge: "complete" };
          } catch (error) { store.entries[p.id] = { digest, decision: "needs_triage", reason: `Residual judgment failed or completion unknown: ${String(error)}`, judge: "failed" }; }
        }
      }
      after = p.id; evaluated++; writeInboxGardenerStore(options.stateDir, store);
    }
    const complete = candidates.length === 0 || after === candidates.at(-1)?.proposal.id;
    store.cursor = { generation, after: complete ? "" : after }; writeInboxGardenerStore(options.stateDir, store);
    return { state: complete ? "complete" : "pending", complete, evaluated, retired, judged, proofReads };
  }, clock).catch(error => ({ state: "failed", delivery: "unknown", complete: false, reason: String(error) }));
}

const RELEVANT_STEPS = ["panel.proposal_reframe_requested", "panel.proposal_declined", "panel.proposal_restored", "ratify.reframed", "ratify.approved", "inbox.gardener_retired", "inbox.gardener_restored", "inbox.gardener_outcome"];
/** BACKSTOP: refuse oversized unverified sources; never label a capped source complete. */
export const INBOX_GARDENER_SOURCE_LIMITS = { registryBytes: 512 * 1024, threadBytes: 1024 * 1024, creditOverrideBytes: 64 * 1024,
  proposals: 2048, relevantRows: 4096, relevantBytes: 512 * 1024, rowBytes: 16 * 1024 } as const;
const relevantProjection: LedgerRowProjection = { name: "inbox-gardener-evidence", version: 2,
  tables: ["inbox_gardener_latest", "inbox_gardener_mirrors"],
  ddl: "CREATE TABLE IF NOT EXISTS inbox_gardener_latest(slot TEXT PRIMARY KEY, proposal TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS inbox_gardener_proposal ON inbox_gardener_latest(proposal); CREATE TABLE IF NOT EXISTS inbox_gardener_mirrors(id TEXT PRIMARY KEY) WITHOUT ROWID;",
  markers: [""],
  apply(db, line, _id, parse) {
    const row = parse();
    if (!row) { db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('inbox-source-fault','malformed-source-row')").run(); return; }
    if (!RELEVANT_STEPS.includes(String(row.step))) return;
    if (Buffer.byteLength(line) > INBOX_GARDENER_SOURCE_LIMITS.rowBytes) {
      db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('inbox-source-fault','oversized-relevant-row')").run(); return;
    }
    const receipt = row.dismissalAuditReceipt as { id?: string } | undefined;
    if (receipt && typeof receipt.id === "string") {
      db.prepare("INSERT OR IGNORE INTO inbox_gardener_mirrors(id) VALUES(?)").run(receipt.id); return;
    }
    const proposal = typeof row.proposal_id === "string" ? row.proposal_id : String(row.task_id ?? "");
    const ts = String(row.ts ?? "");
    db.prepare("INSERT INTO inbox_gardener_latest(slot,proposal,ts,body) VALUES(?,?,?,?) ON CONFLICT(slot) DO UPDATE SET ts=excluded.ts,body=excluded.body WHERE excluded.ts>=inbox_gardener_latest.ts")
      .run(`${proposal}::${row.step}`, proposal, ts, JSON.stringify(row));
  } };

/** Byte-bounded advancement plus indexed current-proposal lookups; never a lifetime table scan. */
export function readInboxGardenerLedger(stateDir: string, scope: InboxGardenerScope, proposalIds: readonly string[] = []) {
  const db = openProjectorReadModel(join(stateDir, "inbox-gardener-evidence"), `inbox-gardener-${inboxSemanticDigest(scope).slice(0, 16)}`);
  const acquired = acquireLease(db);
  try {
    if (!acquired.ok) return { state: "unavailable" as const, rows: [] };
    const tick = createLedgerProjector({ ledgerDir: stateDir, db, lease: acquired.lease, factStep: () => false,
      projections: [relevantProjection], chunkBytes: INBOX_GARDENER_LIMITS.ledgerChunkBytes }).tick({ budgetMs: INBOX_GARDENER_LIMITS.ledgerBudgetMs });
    const quarantined = Number(db.prepare("SELECT COUNT(*) AS n FROM quarantine").get()?.n ?? 0);
    if (tick.torn || tick.quarantined) withWriteTransaction(db, acquired.lease, () => db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('inbox-source-fault', 'torn-or-quarantined')").run());
    const live = fs.openSync(join(stateDir, LEDGER_FILENAME), "r");
    let unfinishedTail = false;
    try { const size = fs.fstatSync(live).size; if (size) { const last = Buffer.alloc(1); fs.readSync(live, last, 0, 1, size - 1); unfinishedTail = last[0] !== 10; } }
    finally { fs.closeSync(live); }
    let incomplete = !!(unfinishedTail || tick.pending || tick.unread.length || tick.torn || tick.quarantined || quarantined || db.meta("inbox-source-fault"));
    const rows: Array<Record<string, any>> = []; let bytes = 0;
    // Each indexed slot has one latest row per relevant step, independent of lifetime ledger size.
    for (const id of proposalIds.slice(0, INBOX_GARDENER_SOURCE_LIMITS.proposals)) {
      for (const row of db.prepare("SELECT body FROM inbox_gardener_latest WHERE proposal=? ORDER BY slot").all(id)) {
        bytes += Buffer.byteLength(String(row.body));
        if (rows.length >= INBOX_GARDENER_SOURCE_LIMITS.relevantRows || bytes > INBOX_GARDENER_SOURCE_LIMITS.relevantBytes) { incomplete = true; break; }
        rows.push(JSON.parse(String(row.body)) as Record<string, any>);
      }
      if (incomplete && bytes > INBOX_GARDENER_SOURCE_LIMITS.relevantBytes || rows.length >= INBOX_GARDENER_SOURCE_LIMITS.relevantRows) break;
    }
    if (proposalIds.length > INBOX_GARDENER_SOURCE_LIMITS.proposals) incomplete = true;
    return { state: incomplete ? "partial" as const : "observed" as const, rows };
  } finally { if (acquired.ok) releaseLease(db, acquired.lease); db.close(); }
}
function hasLedgerMirror(stateDir: string, scope: InboxGardenerScope, id: string): boolean {
  const db = openProjectorReadModel(join(stateDir, "inbox-gardener-evidence"), `inbox-gardener-${inboxSemanticDigest(scope).slice(0, 16)}`);
  try { return !!db.prepare("SELECT id FROM inbox_gardener_mirrors WHERE id=?").get(id); }
  finally { db.close(); }
}

function optionalBoundedFile(path: string, maxBytes: number): string | undefined {
  try { return readInboxGardenerFile(path, maxBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function defaultInboxGardenerPorts(options: { stateDir: string; scope: InboxGardenerScope; planPath: string; codeSha: string; creditOverridePath?: string;
  clock?: Clock; githubJson?: typeof ghJsonAsync; judge?: InboxGardenerPorts["judge"] }): InboxGardenerPorts {
  const clock = options.clock ?? systemClock, githubJson = options.githubJson ?? ghJsonAsync;
  const threadPath = join(options.stateDir, "inbox-threads.jsonl");
  let plan: ReturnType<typeof loadPlan>;
  let retainedRows: Array<Record<string, any>> = [], overrides: Array<Record<string, any>> = [];
  const capture = async (): Promise<InboxGardenerPack> => {
    const snapshot = readPersistedInbox(options.stateDir), raw = parseProposalRegistryResult(readInboxGardenerFile(join(options.stateDir, "inbox-proposals.json"), INBOX_GARDENER_SOURCE_LIMITS.registryBytes));
    const proposals = raw.kind === "ok" ? raw.proposals : [];
    if (proposals.length > INBOX_GARDENER_SOURCE_LIMITS.proposals) throw new Error("Inbox proposal population exceeds verification bound");
    plan = loadPlan(options.planPath);
    const threads = parseAllThreads(optionalBoundedFile(threadPath, INBOX_GARDENER_SOURCE_LIMITS.threadBytes) ?? "", threadPath);
    const ledger = readInboxGardenerLedger(options.stateDir, options.scope, proposals.map(p => p.id));
    retainedRows = ledger.rows;
    if (!fs.statSync(join(options.stateDir, LEDGER_FILENAME)).isFile()) throw new Error("live ledger unavailable");
    const overridePath = options.creditOverridePath ?? join(dirname(options.planPath), "credit-overrides.yaml");
    const overrideText = optionalBoundedFile(overridePath, INBOX_GARDENER_SOURCE_LIMITS.creditOverrideBytes);
    const rawOverrides = overrideText === undefined ? [] : parseYaml(overrideText);
    if (!Array.isArray(rawOverrides) || rawOverrides.some(o => !o || o.action !== "remove-credit" || typeof o.task !== "string" || !Number.isSafeInteger(o.pr) || o.pr < 1 || o.author_class !== "operator" || typeof o.reason !== "string" || !o.reason.trim())) throw new Error("credit override source unverified");
    overrides = rawOverrides;
    const verdicts = ledgerProposalVerdicts([...ledger.rows].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts))));
    const ownership = snapshot?.snapshotScope?.repository === options.scope.repository && snapshot.snapshotScope.instance === options.scope.instance;
    const operatorIntents = new Map(proposals.map(p => [p.id, inboxOperatorIntent(threads.status === "ok" ? threads.threads.get(inboxThreadId(p.id)) ?? [] : [])]));
    return { scope: options.scope, snapshotKey: snapshot?.snapshotKey ?? "", generatedAt: snapshot?.generatedAt ?? "", checkedAt: clock.iso(), codeSha: options.codeSha,
      coverage: { plan: snapshot?.gardenerSource?.identity === inboxGardenerSource(proposals, plan.byId, options.scope, operatorIntents).identity ? snapshot?.attentionCensus?.sources.plan ?? "unavailable" : "unavailable", registry: raw.kind === "ok" && ownership &&
        inboxSemanticDigest(snapshot?.proposals) === inboxSemanticDigest(proposals) ? "observed" : "unavailable", github: snapshot?.attentionCensus?.sources.githubProjection ?? "unavailable",
        ledger: ledger.state, threads: threads.status === "ok" ? "observed" : "unavailable" },
      candidates: proposals.map(proposal => {
        const taskId = mechanicalAskPurpose(proposal)?.taskId;
        const task = taskId ? plan.byId.get(taskId) : undefined;
        const messages = threads.status === "ok" ? threads.threads.get(inboxThreadId(proposal.id)) ?? [] : [];
        const last = messages.at(-1);
        return { proposal, ...(task ? { task: inboxGardenerTaskFact(task) } : {}),
          sourcePolicy: inboxSemanticDigest(overrides.filter(o => o.task === taskId)),
          ...(/^proof-debt:[^:]+:\d+$/.test(proposal.id) ? { successor: { proposal: proposals.find(p => p.id === proposal.id.replace(/:\d+$/, ""))!,
            open: proposals.some(p => p.id === proposal.id.replace(/:\d+$/, "") && !verdicts.isRatified(p.id) && verdicts.isDeclined(p.id) === undefined && snapshot?.classifications.find(c => c.proposalId === p.id)?.state !== "retired") } } : {}),
          ...(task ? { dependencies: task.depends_on.flatMap(id => plan.byId.has(id) ? [inboxGardenerTaskFact(plan.byId.get(id)!)] : []),
            dependencyMerge: task.depends_on.map(id => ({ id, merged: !plan.byId.has(id) || snapshot?.gardenerDependencyEvidence === undefined ? null : snapshot.gardenerDependencyEvidence.find(value => value.id === id)?.merged ?? null })) } : {}),
          operatorIntent: inboxOperatorIntent(messages), unansweredReply: last?.role === "reply" && last.extra?.event === undefined,
          resolvedByOperator: verdicts.isRatified(proposal.id) || verdicts.isDeclined(proposal.id) !== undefined };
      }), ledgerEventIds: new Set(ledger.rows.flatMap(row => typeof row.dismissalAuditReceipt?.id === "string" ? [row.dismissalAuditReceipt.id] : [])) };
  };
  return { capture, judge: options.judge,
    proof: async candidate => {
      const purpose = mechanicalAskPurpose(candidate.proposal);
      if (!purpose || !candidate.task) return undefined;
      if (candidate.task.retirement && candidate.task.status === "blocked") {
        const path = plan.byId.get(purpose.taskId)?.sourcePath;
        if (!path) throw new Error("plan retirement blob unavailable");
        const gitRoot = dirname(dirname(options.planPath));
        const [commit, blob, current] = await Promise.all([hostWorktreeGitAsync(gitRoot, ["rev-parse", "HEAD"], { timeout: 5000 }),
          hostWorktreeGitAsync(gitRoot, ["rev-parse", `HEAD:${relative(gitRoot, path)}`], { timeout: 5000 }),
          hostWorktreeGitAsync(gitRoot, ["hash-object", "--", path], { timeout: 5000 })]);
        if (blob.trim() !== current.trim()) throw new Error("plan retirement differs from its authoritative committed blob");
        return { kind: "plan-retirement", taskId: purpose.taskId, repository: options.scope.repository, instance: options.scope.instance,
          commit: commit.trim(), blob: blob.trim(), retirement: candidate.task.retirement };
      }
      if (candidate.successor?.open && candidate.successor.proposal && mechanicalAskPurpose(candidate.successor.proposal) &&
        candidate.proposal.evidenceAnchors.every(a => candidate.successor!.proposal.evidenceAnchors.some(b => inboxSemanticDigest(a) === inboxSemanticDigest(b))))
        return { kind: "successor", taskId: purpose.taskId, repository: options.scope.repository, instance: options.scope.instance,
          successorId: candidate.successor.proposal.id, revision: inboxProposalRevision(candidate.successor.proposal), predecessorCriteria: purpose.criteriaDigest, present: true, open: true };
      const handoff = retainedRows.find(row => row.step === "ratify.approved" && row.released === "verify-human" && row.author_class === "operator" && row.task_id === purpose.taskId &&
        row.proposal_id === candidate.proposal.id && row.repository === options.scope.repository && row.instance === options.scope.instance && row.handoff_kind === "proof-repair" && typeof row.receipt_id === "string" && typeof row.run_id === "string");
      if (handoff) return { kind: "handoff", taskId: purpose.taskId, repository: options.scope.repository, instance: options.scope.instance, proposalId: candidate.proposal.id,
        receiptId: handoff.receipt_id, runId: handoff.run_id, authority: "operator", released: "verify-human" };
      const fields = "number,url,state,headRefName,headRefOid,body,mergeCommit";
      let detailReads = 0;
      for (const [search, credit] of [[`\"Remudero-Task: ${purpose.taskId}\" in:body`, "trailer"], [`head:run-${purpose.taskId}-`, "run-branch"]] as const) {
        const rows = await githubJson(["pr", "list", "--repo", options.scope.repository, "--state", "merged", "--search", search, "--limit", "10", "--json", fields]);
        if (!Array.isArray(rows)) throw new Error("merged credit source unavailable");
        if (rows.length === 10) throw new Error("merged credit search reached its bound; source partial");
        for (const row of rows) {
          if (overrides.some(o => o?.task === purpose.taskId && o?.pr === row.number && o?.action === "remove-credit")) continue;
          if (row.state !== "MERGED" || credit === "trailer" && !creditsByAnchoredTrailer(row.state, row.headRefName, row.body, purpose.taskId) ||
            credit === "run-branch" && !new RegExp(`^run-${purpose.taskId}-[0-9]+$`).test(row.headRefName)) continue;
          if (++detailReads > 2) throw new Error("credit detail budget exhausted; remaining source is partial");
          const detail = await githubJson(["pr", "view", String(row.number), "--repo", options.scope.repository, "--json", "files"]);
          const paths = (detail as { files?: Array<{ path: string }> })?.files?.map(f => f.path);
          if (!paths || paths.length === 0 || paths.length >= 2000) throw new Error("implementation paths are unavailable or bounded");
          if (refusesAsPlanOnly(plan.byId.get(purpose.taskId)!, paths)) continue;
          const proof: InboxTerminalProof = { kind: "merged-task", taskId: purpose.taskId, repository: options.scope.repository, instance: options.scope.instance,
            number: row.number, url: row.url, state: row.state, headRefName: row.headRefName, headSha: row.headRefOid, mergeSha: row.mergeCommit?.oid, body: row.body ?? "", credit, implementationCredit: true, paths };
          if (validInboxTerminalProof(proof, options.scope, candidate.proposal)) return proof;
        }
      }
      return undefined;
    },
    mirror: async (event, pack) => {
      const step = `inbox.gardener_${event.receipt.kind === "retire" ? "retired" : event.receipt.kind === "restore" ? "restored" : "outcome"}`;
      const row = { ts: event.receipt.at, run_id: `INBOX-GARDENER-${event.receipt.id}`, step, task_id: event.receipt.scope.proposalId,
        origin: event.receipt.kind === "restore" ? event.operator : "inbox-gardener", reason: event.reason, dismissalAuditReceipt: event.receipt };
      if (!pack.ledgerEventIds.has(event.receipt.id) && !hasLedgerMirror(options.stateDir, options.scope, event.receipt.id)) { appendLedger(join(options.stateDir, LEDGER_FILENAME), row); pack.ledgerEventIds.add(event.receipt.id); }
      recordRowThreadEvents(row, undefined, { threadStorePath: join(options.stateDir, "inbox-threads.jsonl") }, () => {});
      // Unlike best-effort legacy mirrors, a missing mirror is explicitly retryable here.
      const threads = parseAllThreads(optionalBoundedFile(threadPath, INBOX_GARDENER_SOURCE_LIMITS.threadBytes) ?? "", threadPath);
      const expected = threadEventsForRow(row);
      if (threads.status !== "ok" || expected.some(e => threads.threads.get(inboxThreadId(e.proposalId))?.some(m => m.extra?.event?.key === e.event.key) !== true)) throw new Error("lifecycle thread mirror unavailable");
    } };
}
