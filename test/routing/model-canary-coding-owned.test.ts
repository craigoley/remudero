import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { codingCaseRequests } from "#src/lib/model-canary-coding.js";
import { validateCodingCheckpoint, codingSlotCase, type CodingCheckpoint } from "#src/lib/model-canary-coding-checkpoint.js";
import { codingContainerCommand, codingExecutorDefaultPorts } from "#src/lib/model-canary-coding-executor.js";
import { executeOwnedCoding, type OwnedCodingPorts } from "#src/lib/model-canary-coding-owned.js";
import { canarySlotEligible, type CanarySlot } from "#src/lib/model-canary-schedule.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const image = "sha256:" + "b".repeat(64), nonce = "c".repeat(32);
const wire = fileURLToPath(new URL("test/fixtures/coding-container-cli.mjs", __workspaceRootUrl));
const submission = { files: [{ path: "src/solution.mjs", text: "export const parseCount = v => Number(v);" }] };
const eligibility = () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
  spareSubscription: true, experimentalCashAllowed: false, premium: false });
function slot(seed = "one"): CanarySlot {
  const request = codingCaseRequests()[0]!;
  return { id: createHash("sha256").update(seed).digest("hex"), caseId: request.id,
    pin: { model: "synthetic-model", route: "subscription", effort: "low", suiteHash: request.suiteHash, billing: "subscription" }, aaLabel: null };
}
const event = (phase: CodingCheckpoint["phase"], containerId: string | null = null): CodingCheckpoint => ({
  version: "canary-coding-checkpoint-v1", phase, nonce, image, directory: "/tmp/rmd-coding-isolated-" + nonce, containerId });
const terminal = () => ({ state: "complete" as const, passed: true, reason: "synthetic-behavior-only", cleanup: "confirmed" as const,
  executorQualified: false as const, resourceEvidence: null });
async function fixture(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), RMD_TMP_PREFIX + "coding-owned-"));
  try { await chmod(dir, 0o700); await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function stored(dir: string, s: CanarySlot) {
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT phase,receipt FROM canary_slots_v1 WHERE id=?").get(s.id); } finally { db.close(); }
}
function cleaned(owner: CanarySlotOwner, s: CanarySlot) {
  owner.codingCheckpoint(s, event("prepared"));
  owner.codingCheckpoint(s, event("cleanup-confirmed"));
}
function ports(scenario: string, before?: (args: string[], cwd: string) => void): OwnedCodingPorts {
  return { eligibility: async () => eligibility(), submission: async () => submission,
    executor: { admission: async () => ({ admitted: true, reason: "synthetic-wire-only" }),
      command: async (args, cwd, limit) => { before?.(args, cwd); return codingContainerCommand(process.execPath, [wire, scenario, ...args], cwd, limit); } } };
}

test("owned coding uses the shared production gate and refuses unqualified runtime before claim or generation", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), s = slot(); let calls = 0;
  const p = ports("good"); p.submission = async () => { calls++; return submission; };
  try {
    for (const delta of [{ sourceAdopted: false }, { adapterQualified: false }, { productionBusy: true }, { squeeze: true }, { spareSubscription: false }]) {
      p.eligibility = async () => ({ ...eligibility(), ...delta });
      assert.equal((await executeOwnedCoding(owner, s, image, p)).state, "deferred");
    }
    p.eligibility = async () => eligibility(); p.executor = codingExecutorDefaultPorts();
    assert.equal((await executeOwnedCoding(owner, s, image, p)).state, "deferred");
    assert.equal(calls, 0); assert.equal(stored(dir, s), undefined);
    const api = { ...s, pin: { ...s.pin, billing: "api" as const } };
    assert.equal(canarySlotEligible(api, { ...eligibility(), experimentalCashAllowed: true }), true);
    assert.equal(canarySlotEligible(api, { ...eligibility(), experimentalCashAllowed: true, premium: true }), false);
    await assert.rejects(executeOwnedCoding(owner, api, image, p), /slot-contract-invalid/);
    await assert.rejects(executeOwnedCoding(owner, s, "node:latest", p), /image-invalid/);
  } finally { owner.close(); }
}));

test("owned coding records intent before real synthetic CLI operations and releases only positive cleanup", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), s = slot(), seen: string[] = [];
  try {
    const r = await executeOwnedCoding(owner, s, image, ports("good", args => {
      const saved = JSON.parse(String(stored(dir, s)!.receipt)); seen.push(saved.checkpoint.phase);
      assert.equal(stored(dir, s)!.phase, "started");
      if (args[0] === "create") { assert.equal(saved.checkpoint.phase, "create-intent"); assert.equal(saved.checkpoint.containerId, null); }
      if (args[0] === "start") assert.equal(saved.checkpoint.phase, "execution-intent");
      if (args[0] === "rm") assert.equal(saved.checkpoint.phase, "cleanup-intent");
    }));
    assert.equal(r.state, "terminal"); assert.equal(r.executorQualified, false);
    assert.equal(stored(dir, s)!.phase, "terminal");
    const receipt = JSON.parse(String(stored(dir, s)!.receipt));
    assert.equal(receipt.checkpoint.phase, "cleanup-confirmed"); assert.equal(receipt.outcome.scope, "unregistered-mechanics-only");
    assert.equal(receipt.outcome.resourceEvidence, null); assert.equal(receipt.run, undefined);
    assert.deepEqual(seen, ["create-intent", "created", "execution-intent", "execution-intent", "cleanup-intent"]);
    assert.equal((await executeOwnedCoding(owner, s, image, ports("good"))).state, "already-owned-or-terminal");
    assert.equal(owner.claim(slot("next")), "claimed");
  } finally { owner.close(); }
}));

test("uncertain real synthetic create or removal retains the shared slot across reopen and blocks every other plan", async () => {
  for (const scenario of ["uncertain-create", "malformed-id", "cleanup-failed"]) await fixture(async dir => {
    const owner = new CanarySlotOwner(dir), s = slot();
    const result = await executeOwnedCoding(owner, s, image, ports(scenario)); owner.close();
    const reopened = new CanarySlotOwner(dir);
    try {
      assert.equal(result.state, "held"); assert.equal(stored(dir, s)!.phase, "started");
      assert.equal(reopened.claim(s), "already-owned-or-terminal"); assert.throws(() => reopened.claim(slot("next")), /busy-or-capacity/);
      assert.throws(() => reopened.codingTerminal(s, terminal()), /not-owned/);
      const retained = "execution" in result ? result.execution?.retainedScratch : undefined;
      if (retained) await rm(retained, { recursive: true, force: true });
    } finally { reopened.close(); }
  });
});

test("production drift refused submissions and failed generation remain owned without a retry", async () => {
  for (const mode of ["after-claim", "before-execution", "invalid-submission", "generation-error"]) await fixture(async dir => {
    const owner = new CanarySlotOwner(dir), s = slot(), p = ports("good"); let checks = 0, generated = 0, commands = 0;
    p.eligibility = async () => ({ ...eligibility(), productionBusy: ++checks === (mode === "after-claim" ? 2 : mode === "before-execution" ? 3 : -1) });
    p.submission = async () => { generated++; if (mode === "generation-error") throw new Error("ambiguous-generation"); return mode === "invalid-submission" ? {} : submission; };
    p.executor.command = async () => { commands++; throw new Error("no command permitted"); };
    try {
      if (mode === "generation-error") await assert.rejects(executeOwnedCoding(owner, s, image, p), /ambiguous-generation/);
      else assert.equal((await executeOwnedCoding(owner, s, image, p)).state, "held");
      assert.equal(stored(dir, s)!.phase, "started"); assert.equal(commands, 0);
      assert.equal(generated, mode === "after-claim" ? 0 : 1); assert.throws(() => owner.claim(slot("next")), /busy-or-capacity/);
    } finally { owner.close(); }
  });
});

test("real closed SQLite journal refuses operations and leaves a restarted owner holding the claim", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), s = slot(), p = ports("good"); let commands = 0;
  p.submission = async () => { owner.close(); return submission; };
  p.executor.command = async () => { commands++; throw new Error("journal must refuse first"); };
  const result = await executeOwnedCoding(owner, s, image, p), reopened = new CanarySlotOwner(dir);
  try {
    assert.equal(result.state, "held"); assert.equal(commands, 0); assert.equal(stored(dir, s)!.phase, "started");
    assert.equal(reopened.claim(s), "already-owned-or-terminal"); assert.throws(() => reopened.claim(slot("next")), /busy-or-capacity/);
  } finally {
    const retained = "execution" in result ? result.execution?.retainedScratch : undefined;
    if (retained) await rm(retained, { recursive: true, force: true });
    reopened.close();
  }
}));

test("a killed actual native child leaves its precreate and known-ID cleanup checkpoints durably held", async () => {
  for (const phase of ["create-intent", "cleanup-intent"]) await fixture(async dir => {
    const s = slot(), script = `import {CanarySlotOwner} from '#test/src/lib/model-canary-owner.ts';
      const owner=new CanarySlotOwner(process.argv[1]),slot=JSON.parse(process.argv[2]),base=JSON.parse(process.argv[3]);
      if(owner.claim(slot)!=='claimed')throw Error('claim');owner.codingCheckpoint(slot,base);
      owner.codingCheckpoint(slot,{...base,phase:'create-intent'});
      if(process.argv[4]==='cleanup-intent'){owner.codingCheckpoint(slot,{...base,phase:'created',containerId:'a'.repeat(64)});
        owner.codingCheckpoint(slot,{...base,phase:'cleanup-intent',containerId:'a'.repeat(64)});}
      process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir, JSON.stringify(s), JSON.stringify(event("prepared")), phase], {
      encoding: "utf8", timeout: 15000, env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: dir, TMPDIR: dir },
    });
    assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(child.status, null);
    const owner = new CanarySlotOwner(dir);
    try {
      assert.equal(JSON.parse(String(stored(dir, s)!.receipt)).checkpoint.phase, phase);
      assert.equal(owner.claim(s), "already-owned-or-terminal"); assert.throws(() => owner.claim(slot("next")), /busy-or-capacity/);
      assert.throws(() => owner.codingCheckpoint(s, event("prepared")), /not-owned/);
    } finally { owner.close(); }
  });
});

test("coding checkpoint identity transitions quotas and ordinary terminal bypass are refused by the real owner", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), foreign = new CanarySlotOwner(dir), s = slot();
  try {
    assert.throws(() => codingSlotCase({ ...s, pin: { ...s.pin, suiteHash: "d".repeat(64) } }), /contract/);
    assert.throws(() => validateCodingCheckpoint(event("created", "a".repeat(64)), null), /first/);
    assert.throws(() => validateCodingCheckpoint({ ...event("prepared"), unexpected: true } as never, null), /invalid/);
    assert.throws(() => validateCodingCheckpoint({ ...event("prepared"), containerId: "bad" }, null), /invalid/);
    assert.throws(() => validateCodingCheckpoint({ ...event("prepared"), image: "tag:latest" }, null), /immutable/);
    const first = event("prepared");
    for (const bad of [{ ...event("create-intent"), nonce: "e".repeat(32) }, { ...event("create-intent"), directory: "/tmp/rmd-coding-isolated-" + "e".repeat(32) },
      event("created", "a".repeat(64)), event("create-intent", "a".repeat(64)), event("cleanup-confirmed", "a".repeat(64))])
      assert.throws(() => validateCodingCheckpoint(bad, first), /identity|transition/);
    assert.throws(() => validateCodingCheckpoint(event("cleanup-intent", "b".repeat(64)), event("created", "a".repeat(64))), /identity/);
    assert.throws(() => validateCodingCheckpoint(event("create-intent"), event("cleanup-confirmed")), /transition/);
    assert.equal(owner.claim(s), "claimed"); assert.throws(() => foreign.codingCheckpoint(s, first), /not-owned/);
    assert.throws(() => owner.codingTerminal(s, terminal()), /checkpointed/);
    const ordinary = { state: "unavailable" as const, reason: "ambiguous-generation", trace: [], grade: null, error: undefined,
      run: { id: "synthetic-run", caseId: s.caseId, suiteHash: s.pin.suiteHash, model: s.pin.model, route: s.pin.route,
        effort: s.pin.effort, family: "structured" as const, verified: null, totalDurationMs: null, attempts: [] } };
    assert.throws(() => owner.terminal(s, ordinary), /requires-cleanup/);
    owner.codingCheckpoint(s, first);
    assert.throws(() => owner.codingTerminal(s, terminal()), /unproven/);
    owner.codingCheckpoint(s, event("cleanup-confirmed"));
    for (const bad of [{ ...terminal(), cleanup: "unknown" }, { ...terminal(), executorQualified: true }, { ...terminal(), resourceEvidence: {} },
      { ...terminal(), passed: null }, { ...terminal(), state: "unavailable", passed: true }, { ...terminal(), reason: "x".repeat(513) }])
      assert.throws(() => owner.codingTerminal(s, bad as never), /unproven/);
    owner.codingTerminal(s, terminal()); assert.throws(() => owner.codingTerminal(s, terminal()), /not-owned/);
  } finally { owner.close(); foreign.close(); }
}));

test("real SQLite ignored writes corrupt checkpoints and receipt bounds retain started ownership", async () => {
  for (const mode of ["checkpoint-conflict", "terminal-conflict", "corrupt", "checkpoint-bound", "terminal-bound"]) await fixture(async dir => {
    const owner = new CanarySlotOwner(dir), s = slot(), db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
    try {
      owner.claim(s);
      if (mode === "checkpoint-conflict") {
        db.exec("CREATE TRIGGER refuse_write BEFORE UPDATE ON canary_slots_v1 BEGIN SELECT RAISE(IGNORE); END;");
        assert.throws(() => owner.codingCheckpoint(s, event("prepared")), /conflict/);
      } else if (mode === "terminal-conflict") {
        cleaned(owner, s); db.exec("CREATE TRIGGER refuse_write BEFORE UPDATE ON canary_slots_v1 BEGIN SELECT RAISE(IGNORE); END;");
        assert.throws(() => owner.codingTerminal(s, terminal()), /conflict/);
      } else if (mode === "corrupt") {
        db.prepare("UPDATE canary_slots_v1 SET receipt=? WHERE id=?").run('{"kind":"unknown"}', s.id);
        assert.throws(() => owner.codingCheckpoint(s, event("prepared")), /kind-invalid/);
      } else if (mode === "checkpoint-bound") {
        assert.throws(() => owner.codingCheckpoint(s, { ...event("prepared"), directory: "/" + "x".repeat(128 * 1024) + "/rmd-coding-isolated-" + nonce }), /bound/);
      } else {
        const first = event("prepared"), baseBytes = Buffer.byteLength(JSON.stringify({ kind: "canary-coding-lifecycle-v1", slot: s, checkpoint: first }));
        const directory = "/" + "x".repeat(128 * 1024 - baseBytes - 40) + first.directory;
        owner.codingCheckpoint(s, { ...first, directory }); owner.codingCheckpoint(s, { ...first, directory, phase: "cleanup-confirmed" });
        assert.throws(() => owner.codingTerminal(s, terminal()), /bound/);
      }
      assert.equal(stored(dir, s)!.phase, "started"); assert.throws(() => owner.claim(slot("next")), /busy-or-capacity/);
    } finally { db.close(); owner.close(); }
  });
});
