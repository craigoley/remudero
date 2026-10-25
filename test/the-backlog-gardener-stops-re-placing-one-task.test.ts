import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBacklogActions, backlogGardenSpec, backlogInventory, readOpenBacklogDecisions, type BacklogAction, type BacklogSources } from "#src/lib/backlog-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import { runGardenAsync } from "#src/lib/gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import type { Task } from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;
const ID = "W1-T6117";

function fixture(t: { after: (fn: () => void) => void }, shardText: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-replace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const rel = `plan/tasks.d/${ID}.yaml`;
  writeFileSync(join(root, rel), shardText);
  const task: Task = { id: ID, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: ["src/x.ts"], rationale: "Observed pr.opened." };
  const shards = new Map([[ID, rel]]);
  const plan: PlanInventory = { open: [task], all: [task], shards };
  let now = T0;
  let rows: Record<string, unknown>[] = [];
  const sources: BacklogSources = {
    repoRoot: root, plan: () => plan, ledger: () => rows, history: () => [], mergedLastDay: () => 2,
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() } as unknown as BacklogSources["clock"],
    fileExists: () => true, proofsHolding: () => new Set(),
  };
  void fixedClock;
  return {
    root, shards, sources, task,
    read: () => readFileSync(join(root, rel), "utf8"),
    setNow: (n: number) => { now = n; },
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
  };
}

const hits = (n: number, at: number) => Array.from({ length: n }, () => ({ step: "pr.opened", ts: new Date(at - HOUR).toISOString() }));

test("W1-T9053: a band main already carries is not rewritten for new evidence alone", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  priority: 2\n  status: queued\n  # backlog gardener: band=2 evidence=fedcba9876543210\n`);
  f.task.priority = 2;
  const action: BacklogAction = {
    class: "place", target: ID, reason: "x", disposition: { kind: "band", band: 2 },
    evidence: { fanout: 0, symptoms: [], missingFiles: [], presentFiles: [], missingSymbols: [], presentSymbols: [], proofsHold: false, signature: "0123456789abcdef" },
  };
  const before = f.read();
  assert.deepEqual(applyBacklogActions(f.root, f.shards, [action], new Date(T0)), []);
  assert.equal(f.read(), before);
});

test("W1-T9053: a task re-banded within the last day is not re-banded again", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  const placements: string[] = [];
  let rowsFor = (n: number) => hits(n, T0);
  for (let h = 0; h < 24; h++) {
    const now = T0 + h * HOUR;
    f.setNow(now);
    // Volume alternates: band 2 on a clear rise, band 3 otherwise.
    f.setRows(h % 2 === 0 ? [...rowsFor(3)].map((r) => ({ ...r, ts: new Date(now - HOUR).toISOString() })) : [{ step: "pr.opened", ts: new Date(now - HOUR).toISOString() }, { step: "pr.opened", ts: new Date(now - 30 * HOUR).toISOString() }, { step: "pr.opened", ts: new Date(now - 31 * HOUR).toISOString() }]);
    const inv = backlogInventory(f.sources);
    f.task.priority = undefined;
    const paths = applyBacklogActions(f.root, f.shards, inv.candidates, new Date(now));
    if (paths.length) {
      placements.push(f.read());
      const m = /priority: (\d)/.exec(f.read());
      f.task.priority = m ? Number(m[1]) : undefined;
    } else {
      const m = /priority: (\d)/.exec(f.read());
      f.task.priority = m ? Number(m[1]) : undefined;
    }
  }
  rowsFor = () => [];
  assert.ok(placements.length <= 1, `at most one placement in 24 hourly passes, saw ${placements.length}`);
});

test("W1-T9053: band 2 needs a clear rise, not any rise", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  f.setRows([
    { step: "pr.opened", ts: new Date(T0 - HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
  ]);
  const c = backlogInventory(f.sources).candidates[0];
  assert.deepEqual(c?.disposition, { kind: "band", band: 3 });
});


test("an open backlog decision defers the same async proposal despite a new evidence hash", async (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  const first = backlogInventory(f.sources).candidates[0]!;
  assert.ok(first, "a positive candidate proves this is not an empty inventory");
  const decision = first.disposition.kind === "band" ? `band ${first.disposition.band}` : first.disposition.retirement;
  f.setRows(hits(1, T0 - 48 * HOUR));
  const changed = backlogInventory(f.sources).candidates[0]!;
  assert.notEqual(changed.evidence.signature, first.evidence.signature);
  assert.deepEqual(changed.disposition, first.disposition, "older evidence changes the hash, not the decision");
  let open = [{ target: ID, decision, prNumber: 14156, headSha: "a".repeat(40) }];
  const events: Array<{ step: string; extra: unknown }> = [];
  const deps = { repoRoot: f.root, stateDir: join(f.root, "state"),
    log: (step: string, extra?: unknown) => { events.push({ step, extra }); },
    openWorkspace: () => { throw new Error("inventory must not open a workspace"); } };
  const spec = backlogGardenSpec(deps, { ...f.sources, openDecisions: async () => open });
  const inventory = async () => spec.inventoryAsync ? spec.inventoryAsync() : spec.inventory();
  assert.deepEqual((await inventory()).candidates, [], "an existing open decision owns this proposal");
  assert.ok(events.some(e => e.step === "backlog.open_decision_deferred"));
  assert.equal((await runGardenAsync(spec, deps)).prUrl, undefined, "the actual garden loop opens no duplicate workspace or PR");
  assert.equal(f.read(), `- id: ${ID}\n  title: t\n  status: queued\n`, "deferral changes no task bytes");
  open = [{ ...open[0]!, target: "W1-T99999" }];
  assert.equal((await inventory()).candidates.length, 1, "another task cannot suppress this decision");
  open = [{ ...open[0]!, target: ID, decision: decision === "band 4" ? "band 3" : "band 4" }];
  assert.equal((await inventory()).candidates.length, 1, "a different decision remains eligible");
  open = [];
  assert.equal((await inventory()).candidates.length, 1, "closed or merged proposals no longer defer it");

  const other = { ...f.task, id: "W1-T6118" };
  const plan = f.sources.plan();
  plan.open.push(other);
  plan.all.push(other);
  const otherShard = `plan/tasks.d/${other.id}.yaml`;
  f.shards.set(other.id, otherShard);
  writeFileSync(join(f.root, otherShard), `- id: ${other.id}\n  title: t\n  status: queued\n`);
  f.sources.mergedLastDay = () => 1;
  const landed: Array<{ paths: string[]; body: string }> = [];
  const gardenDeps = { ...deps, openWorkspace: () => ({ root: f.root,
    land: (proposal: { paths: string[]; body: string }) => {
      landed.push(proposal);
      return "https://example.test/pull/2";
    }, dispose: () => {} }) };
  open = [{ target: ID, decision, prNumber: 14156, headSha: "a".repeat(40) }];
  const bounded = backlogGardenSpec(gardenDeps, { ...f.sources, openDecisions: async () => open });
  const available = await bounded.inventoryAsync!();
  assert.equal(available.mergeBudget, 1);
  assert.deepEqual(available.candidates.map(a => a.target), [other.id], "an owned prefix cannot spend the only proposal slot");
  open = [{ ...open[0]!, decision: "band 3" }];
  assert.deepEqual((await bounded.inventoryAsync!()).candidates.map(a => a.target), [ID], "a changed decision still takes its normal place within the budget");
  open = [{ ...open[0]!, decision }];
  assert.equal((await runGardenAsync(bounded, gardenDeps)).prUrl, "https://example.test/pull/2");
  assert.equal(landed.length, 1);
  assert.deepEqual(landed[0]!.paths, [otherShard]);
  assert.match(landed[0]!.body, /\*\*W1-T6118\*\*: band 4\./);
  assert.equal(f.read(), `- id: ${ID}\n  title: t\n  status: queued\n`, "the existing open proposal's task stays untouched");
  assert.match(readFileSync(join(f.root, otherShard), "utf8"), /priority: 4/);
});

test("unread open backlog ownership refuses the async proposal without opening a workspace", async (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  const spec = backlogGardenSpec({ repoRoot: f.root, stateDir: join(f.root, "state"), log: () => {},
    openWorkspace: () => { throw new Error("must not open workspace"); } },
    { ...f.sources, openDecisions: async () => { throw new Error("open PR pages unread"); } });
  await assert.rejects(async () => spec.inventoryAsync ? spec.inventoryAsync() : spec.inventory(), /open PR pages unread/);
});


test("open backlog decisions use the real Git origin and every returned PR page", async (t) => {
  const repo = gitRepo({ scope: t, seedCommit: false, kind: "backlog-open-prs" });
  repo.addRemote("origin", "https://github.com/craigoley/remudero.git");
  const body = "The backlog gardener (W1-T4941) proposes these plan-only changes.\n\n- **W1-T6117**: band 4. Evidence hash may change.\n- **W1-T9697**: withdrawn. Original evidence remains.";
  const pr = { number: 14156, head: { ref: "backlog-garden-1792935077215", sha: "a".repeat(40) }, body };
  let args: string[] = [];
  const decisions = await readOpenBacklogDecisions(repo.dir, { pages: async a => {
    args = a;
    return [[{ ...pr, head: { ...pr.head, ref: "run-unfiled-123" } }], [pr], []];
  } });
  assert.deepEqual(args, ["api", "--paginate", "--slurp", "repos/craigoley/remudero/pulls?state=open&per_page=100"]);
  assert.deepEqual(decisions, [
    { target: "W1-T6117", decision: "band 4", prNumber: 14156, headSha: "a".repeat(40) },
    { target: "W1-T9697", decision: "withdrawn", prNumber: 14156, headSha: "a".repeat(40) },
  ]);
  assert.deepEqual(await readOpenBacklogDecisions(repo.dir, { pages: async () => [[]] }), [], "a complete empty page is evidence");
  for (const pages of [null, [], [null], [[null]], [[{ ...pr, body: undefined }]], [[{ ...pr, body: null }]], [[{ ...pr, body: "unread decision" }]], [[{ ...pr, body: "The backlog gardener (W1-T4941) proposes these plan-only changes." }]], [[{ ...pr, head: { ...pr.head, sha: "unknown" } }]]]) {
    await assert.rejects(readOpenBacklogDecisions(repo.dir, { pages: async () => pages }), /unreadable/);
  }
  await assert.rejects(readOpenBacklogDecisions(repo.dir, { pages: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
  await assert.rejects(readOpenBacklogDecisions(repo.dir, { origin: async () => "local-only" }), /origin does not identify/);
  await assert.rejects(readOpenBacklogDecisions(repo.dir, { origin: async () => { throw new Error("origin unread"); } }), /origin unread/);
});
