import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixBranchClaimKey, prOwnerCommand } from "../src/run-task.js";

const PR = 4851;
const TASK = "W1-TCLAIM";
const BRANCH = `run-${TASK}-1790000000000`;

function corpusDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-pr-owner-claim-"));
  const idle = {
    ts: "2026-09-12T21:22:30.000Z",
    step: "sweep.disposed",
    task_id: TASK,
    run_id: "SWEEP-1",
    pr_number: PR,
    disposition: "blocked-fixable",
    acted: false,
    reason: "required checks red",
    head_sha: "abc123",
  };
  writeFileSync(join(dir, "ledger.2026-09-12T00-00-00-000Z.ndjson"), JSON.stringify(idle) + "\n");
  writeFileSync(join(dir, "ledger.2026-09-12T00-01-00-000Z.ndjson.gz"), gzipSync(Buffer.from(JSON.stringify({ ts: "2026-09-12T21:23:00.000Z", step: "sweep.pass" }) + "\n")));
  return dir;
}

function writeClaim(dir: string, branch: string, holder: Record<string, unknown>): void {
  mkdirSync(join(dir, "inflight"), { recursive: true });
  writeFileSync(join(dir, "inflight", `${fixBranchClaimKey("acme", "remudero", branch)}.lock`), JSON.stringify(holder));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}

function verdict(dir: string): string {
  const out: string[] = [];
  assert.equal(prOwnerCommand([String(PR)], { stateDir: dir, write: (text) => out.push(text) }), 0);
  return out.join("\n");
}

test("W1-T4209: pr-owner reports a live branch claim as owned", () => {
  const dir = corpusDir();
  try {
    assert.match(verdict(dir), /rmd pr-owner #4851 .+ FREE/);
    writeClaim(dir, BRANCH, { pid: process.pid, run_id: "FIX-LIVE-7", host: undefined, startedAt: new Date().toISOString() });
    const out = verdict(dir);
    assert.match(out, /rmd pr-owner #4851 .+ OWNED/);
    assert.match(out, new RegExp(`live fix branch claim held by pid ${process.pid} \\(run FIX-LIVE-7\\)`));
    assert.match(out, /fix branch claim: fix-branch--acme--remudero--run-W1-TCLAIM-1790000000000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4209: pr-owner reports a claim whose holder pid is dead as stale, not owned", () => {
  const dir = corpusDir();
  try {
    writeClaim(dir, BRANCH, { pid: deadPid(), run_id: "FIX-DEAD-1", startedAt: new Date().toISOString() });
    const out = verdict(dir);
    assert.match(out, /rmd pr-owner #4851 .+ FREE/);
    assert.match(out, /stale branch claim held by dead pid \d+/);
    assert.doesNotMatch(out, /OWNED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4209: pr-owner ignores another branch's claim and an unparseable claim file", () => {
  const dir = corpusDir();
  try {
    writeClaim(dir, "run-W1-TOTHER-1790000000001", { pid: process.pid, run_id: "FIX-OTHER", startedAt: new Date().toISOString() });
    writeFileSync(join(dir, "inflight", `${fixBranchClaimKey("acme", "remudero", BRANCH)}.lock`), "{not json");
    assert.match(verdict(dir), /rmd pr-owner #4851 .+ FREE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4209: pr-owner reports UNKNOWN, never FREE, when the inflight directory is unreadable", () => {
  const dir = corpusDir();
  try {
    writeFileSync(join(dir, "inflight"), "not a directory");
    const out = verdict(dir);
    assert.match(out, /rmd pr-owner #4851 .+ UNKNOWN/);
    assert.match(out, /inflight claims unreadable/);
    assert.doesNotMatch(out, /FREE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
