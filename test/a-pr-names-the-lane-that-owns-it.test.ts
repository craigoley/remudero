import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { COMMANDS, HANDLERS, derivePrOwnerVerdict, prOwnerCommand } from "../src/run-task.js";

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-pr-owner-"));
}

function row(fields: Record<string, unknown>): string {
  return JSON.stringify(fields) + "\n";
}

function writeCorpus(dir: string, parts: { plain?: string; gzip?: string; live?: string }): void {
  mkdirSync(dir, { recursive: true });
  if (parts.plain !== undefined) writeFileSync(join(dir, "ledger.2026-09-12T00-00-00-000Z.ndjson"), parts.plain);
  if (parts.gzip !== undefined) {
    writeFileSync(join(dir, "ledger.2026-09-12T00-01-00-000Z.ndjson.gz"), gzipSync(Buffer.from(parts.gzip)));
  }
  if (parts.live !== undefined) writeFileSync(join(dir, "ledger.ndjson"), parts.live);
}

function runPrOwner(dir: string, pr: number): string {
  const out: string[] = [];
  const code = prOwnerCommand([String(pr)], { stateDir: dir, write: (text) => out.push(text) });
  assert.equal(code, 0);
  return out.join("\n");
}

test("a PR with a recent fix.dispatch row reports OWNED and names the strike and strike cap the lane is on", () => {
  const dir = tmpStateDir();
  try {
    writeCorpus(dir, {
      plain: row({
        ts: "2026-09-12T21:22:30.000Z",
        step: "sweep.disposed",
        task_id: "W1-TOWNED",
        run_id: "SWEEP-1",
        pr_number: 4851,
        pr_url: "https://github.com/acme/remudero/pull/4851",
        disposition: "blocked-fixable",
        acted: true,
        reason: "required checks red -- ci-log fix, strike 1/2",
        head_sha: "abc123",
      }),
      gzip: row({
        ts: "2026-09-12T21:23:13.000Z",
        step: "fix.dispatch",
        task_id: "W1-TOWNED",
        run_id: "FIX-1",
        strike: 1,
        strike_cap: 2,
        mode: "ci-log",
        head_sha: "abc123",
      }),
      live: row({
        ts: "2026-09-12T21:26:29.000Z",
        step: "sweep.disposed",
        task_id: "W1-TOWNED",
        run_id: "SWEEP-2",
        pr_number: 4851,
        pr_url: "https://github.com/acme/remudero/pull/4851",
        disposition: "wait",
        acted: false,
        reason: "checks pending 6m (< 60m ceiling)",
        head_sha: "abc123",
      }),
    });

    const out = runPrOwner(dir, 4851);
    assert.match(out, /rmd pr-owner #4851 .+ OWNED/);
    assert.match(out, /strike=1\/2/);
    assert.match(out, /mode=ci-log/);
    assert.match(out, /sweep\.disposed: .*disposition=wait/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PR with no lane row reports FREE, while an unreadable ledger reports UNKNOWN instead", () => {
  const dir = tmpStateDir();
  try {
    writeCorpus(dir, {
      plain: row({
        ts: "2026-09-12T21:22:30.000Z",
        step: "sweep.disposed",
        task_id: "W1-OTHER",
        pr_number: 9999,
        disposition: "blocked-fixable",
        acted: true,
        reason: "other PR",
        head_sha: "other",
      }),
      gzip: row({
        ts: "2026-09-12T21:23:13.000Z",
        step: "fix.dispatch",
        task_id: "W1-OTHER",
        strike: 1,
        strike_cap: 2,
        mode: "ci-log",
        head_sha: "other",
      }),
      live: row({ ts: "2026-09-12T21:24:00.000Z", step: "sweep.pass", enumerated: 1 }),
    });

    assert.match(runPrOwner(dir, 4851), /rmd pr-owner #4851 .+ FREE/);

    const out: string[] = [];
    const code = prOwnerCommand(["4851"], {
      readLedger: () => {
        throw new Error("permission denied");
      },
      write: (text) => out.push(text),
    });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /rmd pr-owner #4851 .+ UNKNOWN/);
    assert.doesNotMatch(out.join("\n"), /FREE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the verdict names the corpus newest timestamp so stale reads are visible", () => {
  const verdict = derivePrOwnerVerdict(12, {
    archiveFiles: ["ledger.2026-09-12T00-01-00-000Z.ndjson.gz"],
    liveFileRead: false,
    ok: true,
    unread: [],
    filesRead: 1,
    rows: [
      { ts: "2026-09-12T00:00:00.000Z", step: "sweep.disposed", pr_number: 12, disposition: "wait", reason: "old wait" },
      { ts: "2026-09-12T00:05:00.000Z", step: "sweep.pass", enumerated: 1 },
    ],
  });
  assert.equal(verdict.verdict, "OWNED");
  assert.equal(verdict.corpusNewestTs, "2026-09-12T00:05:00.000Z");
});

test("an acted fixable sweep owns the PR unless it was explicitly unspent", () => {
  const active = derivePrOwnerVerdict(12, {
    archiveFiles: ["ledger.2026-09-12T00-01-00-000Z.ndjson.gz"],
    liveFileRead: true,
    ok: true,
    unread: [],
    filesRead: 1,
    rows: [
      {
        ts: "2026-09-12T00:00:00.000Z",
        step: "sweep.disposed",
        pr_number: 12,
        disposition: "blocked-fixable",
        acted: true,
        reason: "ci-log fix dispatched",
      },
    ],
  });
  assert.equal(active.verdict, "OWNED");
  assert.equal(active.reason, "active sweep disposition found for this pull request");

  const unspent = derivePrOwnerVerdict(12, {
    archiveFiles: ["ledger.2026-09-12T00-01-00-000Z.ndjson.gz"],
    liveFileRead: true,
    ok: true,
    unread: [],
    filesRead: 1,
    rows: [
      {
        ts: "2026-09-12T00:00:00.000Z",
        step: "sweep.disposed",
        pr_number: 12,
        disposition: "blocked-fixable",
        acted: true,
        spent: false,
        reason: "reservation lost before dispatch",
      },
    ],
  });
  assert.equal(unspent.verdict, "FREE");
});

test("pr-owner rejects unknown flags and missing PR numbers with usage", () => {
  const errors: string[] = [];
  assert.equal(prOwnerCommand(["4851", "--json"], { error: (text) => errors.push(text) }), 2);
  assert.match(errors.join("\n"), /unexpected argument '--json'/);
  assert.match(errors.join("\n"), /rmd pr-owner <pr-number>/);

  errors.length = 0;
  assert.equal(prOwnerCommand([], { error: (text) => errors.push(text) }), 2);
  assert.match(errors.join("\n"), /<pr-number> is required/);
  assert.match(errors.join("\n"), /rmd pr-owner <pr-number>/);
});

test("the read covers live, plain rotation and gzip rotation, and no gzip rotation reports UNKNOWN", () => {
  const allForms = tmpStateDir();
  const noGzip = tmpStateDir();
  try {
    writeCorpus(allForms, {
      plain: row({ ts: "2026-09-12T00:00:00.000Z", step: "sweep.pass", enumerated: 1 }),
      gzip: row({ ts: "2026-09-12T00:01:00.000Z", step: "sweep.pass", enumerated: 1 }),
      live: row({ ts: "2026-09-12T00:02:00.000Z", step: "sweep.pass", enumerated: 1 }),
    });
    const free = runPrOwner(allForms, 77);
    assert.match(free, /FREE/);
    assert.match(free, /files_read=3/);
    assert.match(free, /archives=2/);
    assert.match(free, /compressed_archives=1/);
    assert.match(free, /live=yes/);

    writeCorpus(noGzip, {
      plain: row({ ts: "2026-09-12T00:00:00.000Z", step: "sweep.pass", enumerated: 1 }),
      live: row({ ts: "2026-09-12T00:02:00.000Z", step: "sweep.pass", enumerated: 1 }),
    });
    const unknown = runPrOwner(noGzip, 77);
    assert.match(unknown, /UNKNOWN/);
    assert.match(unknown, /no compressed ledger rotation opened/);
    assert.doesNotMatch(unknown, /FREE/);
  } finally {
    rmSync(allForms, { recursive: true, force: true });
    rmSync(noGzip, { recursive: true, force: true });
  }
});

test("the verb is registered and dispatchable as rmd pr-owner without a worker lane", () => {
  assert.ok(COMMANDS.some((c) => c.name === "pr-owner" && c.syntax === "rmd pr-owner <pr-number>"));
  assert.ok(HANDLERS.has("pr-owner"));
});
