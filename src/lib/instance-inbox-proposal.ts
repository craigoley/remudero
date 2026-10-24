import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { parseProposalRegistryResult, reframeProposal, updateProposalRegistry, type DraftCache, type Proposal } from "./inbox.js";
import { appendPanelLedger, bearerTokenId, jsonAction, sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";

type Source = { stateDir: string; ledgerPath: string };
export const proposalSnapshotKey = (proposal: Proposal): string => createHash("sha256").update(JSON.stringify(proposal)).digest("hex");

function proposals(source: Source): Proposal[] {
  const read = parseProposalRegistryResult(readFileSync(join(source.stateDir, "inbox-proposals.json"), "utf8"));
  if (read.kind !== "ok") throw new Error(`proposal registry ${read.kind === "fault" ? read.reason : "absent"}`);
  if (!read.proposals.every(p => typeof p === "object" && p !== null && typeof p.id === "string" && typeof p.summary === "string")) throw new Error("proposal registry has invalid records");
  return read.proposals;
}

function draftCache(source: Source): DraftCache {
  let text: string;
  try { text = readFileSync(join(source.stateDir, "inbox-drafts.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("draft cache is malformed");
  return parsed as DraftCache;
}

type Reframe = { proposalId: string; feedback: string; snapshotKey: string; intentId: string };
function validate(body: unknown): Reframe | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.proposalId !== "string" || !b.proposalId.trim()) return { error: "proposalId is required" };
  if (typeof b.feedback !== "string" || !b.feedback.trim() || b.feedback.length > 4000) return { error: "feedback must contain 1-4000 characters" };
  if (typeof b.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshotKey)) return { error: "proposal snapshotKey is required" };
  if (typeof b.intentId !== "string") return { error: "intentId is required" };
  return { proposalId: b.proposalId, feedback: b.feedback, snapshotKey: b.snapshotKey, intentId: b.intentId };
}

/** These source routes edit only their bound registry/cache/ledger; they never launch a core CLI. */
export function buildInstanceProposalRoutes(source: Source): Route[] {
  return [
    { method: "GET", path: "/v1/inbox/proposal", scope: "read", handler: (req, res) => {
      const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id");
      let active: Proposal[];
      try { active = proposals(source); }
      catch (error) {
        // An unreadable registry cannot establish absence; the reader sees unavailable, never an empty list.
        sendJson(res, 503, { error: "proposal_source_unavailable", detail: String(error) }); return;
      }
      const proposal = active.find(p => p.id === id);
      if (!proposal) { sendJson(res, 404, { error: "not_found" }); return; }
      sendJson(res, 200, { proposalId: proposal.id, summary: proposal.summary.slice(0, 4000), snapshotKey: proposalSnapshotKey(proposal),
        actions: [{ action: "reframe", tier: "low" }] });
    } },
    { method: "POST", path: "/v1/inbox/reframe", scope: "write", tier: "low", handler: (req, res, ctx) => jsonAction(validate, (input, req, res) => {
      const result: { outcome: "missing" | "stale" | "written" } = { outcome: "missing" };
      try {
        proposals(source);
        updateProposalRegistry(join(source.stateDir, "inbox-proposals.json"), current => {
          proposals(source);
          const proposal = current.find(p => p.id === input.proposalId);
          if (!proposal) return null;
          if (proposalSnapshotKey(proposal) !== input.snapshotKey) { result.outcome = "stale"; return null; }
          const reframed = reframeProposal(proposal, input.feedback, draftCache(source), {
            ledgerPath: source.ledgerPath, runId: `INSTANCE-REFRAME-${input.intentId}`,
            ...(ctx.params?.inboxThreadRepository ? { causalScope: { repository: ctx.params.inboxThreadRepository,
              instance: ctx.params.inboxThreadInstance }, inputId: createHash("sha256").update(`${bearerTokenId(req)}\0${input.intentId}`).digest("hex") } : {}),
            threadStorePath: join(source.stateDir, "inbox-threads.jsonl"),
          });
          writeAtomic(join(source.stateDir, "inbox-drafts.json"), JSON.stringify(reframed.drafts));
          result.outcome = "written";
          return current.map(p => p.id === input.proposalId ? reframed.proposal : p);
        });
        if (result.outcome === "written") {
          appendPanelLedger(source.ledgerPath, "panel.proposal_reframe_requested", input.proposalId, bearerTokenId(req), {
            feedback: input.feedback, intent_id: input.intentId, proposal_snapshot: input.snapshotKey,
          });
        }
      } catch (error) { sendJson(res, 503, { error: "reframe_source_unavailable", delivery: "unknown", detail: String(error) }); return; }
      if (result.outcome === "missing") { sendJson(res, 404, { error: "not_found", delivery: "not_delivered" }); return; }
      if (result.outcome === "stale") { sendJson(res, 409, { error: "proposal_snapshot_changed", delivery: "not_delivered" }); return; }
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, delivery: "delivered", draftInvalidated: true });
    })(req, res) },
  ];
}
