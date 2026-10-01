import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import type { GhCallPacer } from "../src/lib/github-transport.js";
import {
  MUTATION_VERDICT_PULL_MAX_DOWNLOADS,
  ledgerTextFromArtifactZip,
  readMutationVerdictZip,
  wellFormedVerdictRows,
  mutationVerdictArtifactZipRestArgs,
  mutationVerdictArtifactsRestArgs,
} from "../src/lib/mutation-verdict-pull.js";
import { MUTATION_GATE_VERDICT_STEP, mutationGateLifetime, parseLedger } from "../src/lib/retro.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runSweep } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// ── W1-T2927: a verdict written inside a CI runner reaches the ledger that reports it ─────────
//
// `scripts/mutation-ratchet.mjs` only runs inside a GitHub Actions runner, whose filesystem is
// discarded with the job, so `mutationGateLifetime` on the host read N=0 however many gates ran.
// Route (a), ruled 2026-09-30: the host sweep pulls the `mutation-verdict-ledger` artifact ci.yml
// uploads. Every test below drives the REAL gate CLI to make the payload, a real zip around it, and
// the real `buildSweepEffects` + `runSweep` pull -- nothing asserts from the emitting side alone.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");
const OWNER = "acme";
const REPO = "widgets";

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t2927-${kind}-`));
}

/** One CI runner: the real gate, run with the env Actions gives it, writing where ci.yml's
 *  `--ledger "$GITHUB_WORKSPACE/state/ledger.ndjson"` points. Returns that file's text, or
 *  undefined when the gate wrote none (which is what `upload-artifact` then uploads nothing for). */
function gateRun(args: string[], runId: string): string | undefined {
  const workspace = scratch("runner");
  const ledger = join(workspace, "state", "ledger.ndjson");
  const res = spawnSync(process.execPath, [SCRIPT, ...args, "--ledger", ledger], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_ROOT: "",
      GITHUB_RUN_ID: runId,
      GITHUB_SHA: "",
      GITHUB_REF: "refs/pull/77/merge",
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    },
  });
  assert.ok(res.status === 0 || res.status === 1, res.stdout + res.stderr);
  return existsSync(ledger) ? readFileSync(ledger, "utf8") : undefined;
}

/** A GitHub Actions artifact zip: one DEFLATED member, as `upload-artifact` produces. */
function artifactZip(name: string, text: string): Buffer {
  const nameBuf = Buffer.from(name);
  const raw = Buffer.from(text);
  const data = deflateRawSync(raw);
  const crc = crc32(raw);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

interface Hosted {
  id: number;
  runId: string;
  zip: Buffer;
  expired?: boolean;
  createdAt?: string;
}

/** GitHub as the sweep reads it: the artifact listing and the zip downloads, with every call logged. */
function fakeGithub(hosted: Hosted[], opts: { listThrows?: boolean; zipThrows?: ReadonlySet<number> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    readJson: (args: string[]) => {
      calls.push(String(args[1]));
      assert.equal(args[1], mutationVerdictArtifactsRestArgs(OWNER, REPO)[1], "the one list call, for this artifact name");
      if (opts.listThrows) throw new Error("list 500");
      return {
        total_count: hosted.length,
        artifacts: hosted.map((h) => ({
          id: h.id,
          name: "mutation-verdict-ledger",
          expired: h.expired ?? false,
          created_at: h.createdAt ?? `2026-09-30T00:00:${String(h.id % 60).padStart(2, "0")}Z`,
          workflow_run: { id: Number(h.runId) },
        })),
      };
    },
    readZip: (args: string[]) => {
      calls.push(String(args[1]));
      const h = hosted.find((x) => args[1] === mutationVerdictArtifactZipRestArgs(OWNER, REPO, x.id)[1]);
      assert.ok(h, `an unlisted artifact was downloaded: ${args[1]}`);
      if (opts.zipThrows?.has(h.id)) throw new Error("zip 500");
      return h.zip;
    },
  };
}

/** The host: the real effect built the way the daemon builds it, then one real `runSweep` pass. */
function host(gh: ReturnType<typeof fakeGithub>, ledger: Array<Record<string, unknown>>, pacer?: GhCallPacer) {
  const logs: string[] = [];
  const effects = buildSweepEffects({
    owner: OWNER,
    repo: REPO,
    config: { root: REPO } as never,
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "t2927",
    plan: { tasks: [], byId: new Map() } as never,
    log: (step) => void logs.push(step),
    policy: DEFAULT_SWEEP_POLICY,
    pacer,
    ghJsonImpl: gh.readJson,
    ghBufferImpl: gh.readZip,
  });
  const pass = (surface?: "light" | "full") =>
    runSweep(
      [],
      {
        arm: () => {},
        close: () => {},
        dispatchFix: () => {},
        escalate: () => {},
        ledgerPath: "/dev/null/ledger.ndjson",
        runId: "t2927",
        readLedger: () => [...ledger],
        appendLine: (_p, line) => void ledger.push(line),
        now: () => 1_000,
        log: (step) => void logs.push(String(step)),
        pullMutationVerdicts: effects.pullMutationVerdicts,
        repairAdmissionSurface: surface,
      },
      DEFAULT_SWEEP_POLICY,
    );
  return { pass, logs };
}

const lifetime = (ledger: Array<Record<string, unknown>>) =>
  mutationGateLifetime(parseLedger(ledger.map((l) => JSON.stringify(l)).join("\n")));

test("W1-T2927: a verdict from a real gate run reaches the host ledger and mutationGateLifetime counts it, once", async () => {
  const passed = gateRun(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], "910001");
  assert.ok(passed, "the real gate wrote its verdict inside the runner");
  const gh = fakeGithub([{ id: 9101, runId: "910001", zip: artifactZip("ledger.ndjson", passed) }]);
  const ledger: Array<Record<string, unknown>> = [];
  const { pass } = host(gh, ledger);

  assert.deepEqual(lifetime(ledger), { positiveControl: false, runCount: 0, killed: 0, survived: 0, escapeCount: 0, escapes: [] });

  await pass();
  const rows = ledger.filter((l) => l.step === MUTATION_GATE_VERDICT_STEP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.run_id, "910001");
  assert.equal(rows[0]!.conclusion, "success");
  assert.equal(rows[0]!.pr_url, `https://github.com/${OWNER}/${REPO}/pull/77`);
  const after = lifetime(ledger);
  assert.equal(after.positiveControl, true);
  assert.equal(after.runCount, 1, "a run count grown by exactly one");

  // Nothing is recorded twice: the second pass reads the list, finds the run id held, downloads nothing.
  const downloadsBefore = gh.calls.filter((c) => c.endsWith("/zip")).length;
  await pass();
  assert.equal(ledger.filter((l) => l.step === MUTATION_GATE_VERDICT_STEP).length, 1);
  assert.equal(gh.calls.filter((c) => c.endsWith("/zip")).length, downloadsBefore, "a recorded run is never downloaded again");
  assert.equal(lifetime(ledger).runCount, 1);
});

test("W1-T2927: a BLOCKING verdict is pulled too, and a second run grows the count by exactly one", async () => {
  const passed = gateRun(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], "910011");
  const blocked = gateRun(["--report", join(FIXTURES, "below-baseline.json"), "--baseline", BASELINE], "910012");
  assert.ok(passed && blocked);
  const ledger: Array<Record<string, unknown>> = [];
  await host(fakeGithub([{ id: 9111, runId: "910011", zip: artifactZip("ledger.ndjson", passed) }]), ledger).pass();
  assert.equal(lifetime(ledger).runCount, 1);

  await host(
    fakeGithub([
      { id: 9111, runId: "910011", zip: artifactZip("ledger.ndjson", passed) },
      { id: 9112, runId: "910012", zip: artifactZip("ledger.ndjson", blocked) },
    ]),
    ledger,
  ).pass();
  const after = lifetime(ledger);
  assert.equal(after.runCount, 2);
  assert.equal(after.escapeCount, 1);
  assert.equal(after.escapes[0]!.runId, "910012");
});

test("W1-T2927: a diff-scoped skip puts NO row on the transport, so the host ledger gains nothing", async () => {
  // The real gate, on a diff that cannot move the score: it writes no ledger, so the workflow's
  // `if-no-files-found: ignore` upload publishes no artifact and the host has nothing to list.
  assert.equal(gateRun(["--changed-files", join(FIXTURES, "changed-files-plan-only.txt")], "910021"), undefined);
  assert.equal(gateRun(["--changed-files", join(FIXTURES, "changed-files-classify.txt")], "910022"), undefined);

  const gh = fakeGithub([]);
  const ledger: Array<Record<string, unknown>> = [];
  await host(gh, ledger).pass();
  assert.deepEqual(ledger, []);
  assert.deepEqual(gh.calls, [mutationVerdictArtifactsRestArgs(OWNER, REPO)[1]], "one list, no download");
  assert.equal(lifetime(ledger).positiveControl, false);
});

test("W1-T2927: only well-formed verdict rows are appended, and a malformed artifact is not read again", async () => {
  const good = JSON.parse((gateRun(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], "910031") ?? "").trim());
  const text = [
    "not json at all",
    JSON.stringify({ ...good, run_id: "910032", step: "something.else" }),
    JSON.stringify({ ...good, run_id: "" }),
    JSON.stringify({ ...good, run_id: "910033", conclusion: "maybe" }),
    JSON.stringify({ ...good, run_id: "910034", killed: "many" }),
    JSON.stringify({ ...good, run_id: "910035", survived: -1 }),
    JSON.stringify({ ...good, run_id: "910036", no_coverage: undefined }),
    JSON.stringify(good),
    JSON.stringify(good), // the same run twice in one artifact
    "",
  ].join("\n");
  const junk = artifactZip("ledger.ndjson", "nothing but prose\n");
  const wrongMember = artifactZip("README.txt", JSON.stringify(good));
  const gh = fakeGithub([
    { id: 9131, runId: "910031", zip: artifactZip("ledger.ndjson", text) },
    { id: 9132, runId: "910037", zip: junk },
    { id: 9133, runId: "910038", zip: wrongMember },
    { id: 9134, runId: "910039", zip: Buffer.from("this is not a zip") },
  ]);
  const ledger: Array<Record<string, unknown>> = [];
  const { pass, logs } = host(gh, ledger);

  await pass();
  const rows = ledger.filter((l) => l.step === MUTATION_GATE_VERDICT_STEP);
  assert.deepEqual(rows.map((r) => r.run_id), ["910031"]);
  assert.equal(rows[0]!.killed, good.killed);
  assert.equal(rows[0]!.emitted_host, good.host, "the runner's identity is kept, not passed off as the host's");
  assert.equal(rows[0]!.ts, undefined, "appendLedger stamps the host's own ts");
  assert.ok(logs.includes("sweep.mutation_verdict_pull.error"), "the unzip failure is reported, not swallowed");

  // The three artifacts that yielded nothing are settled: a second pass downloads none of them.
  const before = gh.calls.filter((c) => c.endsWith("/zip")).length;
  await pass();
  assert.equal(gh.calls.filter((c) => c.endsWith("/zip")).length, before);
});

test("W1-T2927: the pull is paced like every other sweep read, and bounded per pass", async () => {
  const text = gateRun(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], "0");
  assert.ok(text);
  const row = JSON.parse(text.trim());
  const total = MUTATION_VERDICT_PULL_MAX_DOWNLOADS + 3;
  const hosted: Hosted[] = Array.from({ length: total }, (_, i) => ({
    id: 9200 + i,
    runId: String(920000 + i),
    zip: artifactZip("ledger.ndjson", JSON.stringify({ ...row, run_id: String(920000 + i) })),
    expired: i === 0, // an expired artifact is never fetched
    createdAt: `2026-09-30T00:00:${String(i).padStart(2, "0")}Z`,
  }));
  const gh = fakeGithub(hosted);
  const waits: number[] = [];
  const results: boolean[] = [];
  const pacer: GhCallPacer = {
    wait: () => void waits.push(gh.calls.length),
    recordResult: (limited) => void results.push(limited),
  };
  const ledger: Array<Record<string, unknown>> = [];
  await host(gh, ledger, pacer).pass();

  assert.equal(gh.calls.length, 1 + MUTATION_VERDICT_PULL_MAX_DOWNLOADS, "one list plus at most the per-pass bound of downloads");
  assert.equal(waits.length, gh.calls.length, "every GitHub call waited on the pacer first");
  assert.deepEqual(waits, [0, 1, 2, 3, 4, 5], "each wait came BEFORE its call");
  assert.equal(results.length, gh.calls.length);
  const ingested = ledger.filter((l) => l.step === MUTATION_GATE_VERDICT_STEP).map((l) => l.run_id);
  assert.equal(ingested.length, MUTATION_VERDICT_PULL_MAX_DOWNLOADS);
  assert.ok(!ingested.includes("920000"), "the expired artifact was skipped");
  assert.deepEqual(ingested, [...ingested].sort(), "oldest first, so a backlog lands in the order it ran");

  await host(gh, ledger, pacer).pass();
  assert.equal(ledger.filter((l) => l.step === MUTATION_GATE_VERDICT_STEP).length, total - 1, "the backlog drains over passes");
});

test("W1-T2927: a failed read is retried, a failed list never fails the pass, and a light pass reads nothing", async () => {
  const text = gateRun(["--report", join(FIXTURES, "above-baseline.json"), "--baseline", BASELINE], "930001");
  assert.ok(text);
  const flaky = new Set([9301]);
  const gh = fakeGithub([{ id: 9301, runId: "930001", zip: artifactZip("ledger.ndjson", text) }], { zipThrows: flaky });
  const ledger: Array<Record<string, unknown>> = [];
  const { pass, logs } = host(gh, ledger);

  await pass("light");
  assert.deepEqual(gh.calls, [], "a light pass fans out per PR and never pulls");

  await pass();
  assert.equal(ledger.length, 0, "a download that failed recorded nothing");
  assert.ok(logs.includes("sweep.mutation_verdict_pull.error"));

  flaky.clear();
  await pass();
  assert.equal(lifetime(ledger).runCount, 1, "the failure was transient, so the next pass retried it");

  const broken = host(fakeGithub([], { listThrows: true }), [], undefined);
  const summary = await broken.pass();
  assert.ok(summary);
  assert.ok(broken.logs.includes("sweep.mutation_verdict_pull.error"));
});

test("W1-T2927: the transport is the CI upload that already exists, with no write credential in CI", () => {
  const ci = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  mutation-ratchet:"), ci.indexOf("\n  learnings-budget-ratchet:"));
  const step = job.slice(job.indexOf("name: Upload the mutation verdict ledger"));
  assert.match(step, /name: mutation-verdict-ledger/);
  assert.match(step, /path: state\/ledger\.ndjson/);
  assert.ok(job.length > 0 && step.length > 0, "the mutation-ratchet job and its upload step exist");
  assert.doesNotMatch(job, /secrets\./, "route (b) is declined: the mutation job holds no secret to write with");
});

test("W1-T2927: the default zip read is the real GitHub CLI transport", { concurrency: false }, () => {
  // `ghBufferImpl` omitted means this reader: it must really spawn the CLI, here the shared shim.
  const shim = ghShim([{ when: "/artifacts/9401/zip", stdout: "zip-bytes" }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  try {
    const got = readMutationVerdictZip(mutationVerdictArtifactZipRestArgs(OWNER, REPO, 9401));
    assert.equal(got.toString("utf8").trim(), "zip-bytes");
    assert.deepEqual(shim.calls(), [`api repos/${OWNER}/${REPO}/actions/artifacts/9401/zip`]);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("W1-T2927: a throwing pull never fails the sweep pass", async () => {
  const logged: string[] = [];
  const summary = await runSweep(
    [],
    {
      arm: () => {},
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson",
      runId: "t2927",
      readLedger: () => [],
      appendLine: () => {},
      now: () => 1_000,
      log: (step) => void logged.push(String(step)),
      pullMutationVerdicts: async () => {
        throw new Error("boom");
      },
    },
    DEFAULT_SWEEP_POLICY,
  );
  assert.ok(summary);
  assert.ok(logged.includes("sweep.mutation_verdict_pull.error"));
});

test("W1-T2927: the zip reader takes a stored member, finds none when absent, and throws on a non-zip", () => {
  const stored = (name: string, text: string): Buffer => {
    const z = artifactZip(name, text);
    const method = z.readUInt16LE(8);
    assert.equal(method, 8);
    // Rebuild as STORED: same layout, method 0, the raw bytes in place of the deflated ones.
    const nameLen = z.readUInt16LE(26);
    const deflatedLen = z.readUInt32LE(18);
    const raw = Buffer.from(text);
    const local = Buffer.from(z.subarray(0, 30 + nameLen));
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(raw.length, 18);
    const central = Buffer.from(z.subarray(30 + nameLen + deflatedLen, z.length - 22));
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(raw.length, 20);
    const end = Buffer.from(z.subarray(z.length - 22));
    end.writeUInt32LE(local.length + raw.length, 16);
    return Buffer.concat([local, raw, central, end]);
  };
  assert.equal(ledgerTextFromArtifactZip(stored("state/ledger.ndjson", "plain text")), "plain text");
  assert.equal(ledgerTextFromArtifactZip(artifactZip("other.txt", "x")), undefined);
  assert.throws(() => ledgerTextFromArtifactZip(Buffer.from("nope")), /not a zip/);
  const centralAt = (z: Buffer): number => z.readUInt32LE(z.length - 22 + 16);
  const damaged = artifactZip("ledger.ndjson", "x");
  damaged.writeUInt32LE(0, centralAt(damaged));
  assert.throws(() => ledgerTextFromArtifactZip(damaged), /corrupt zip/);
  const dangling = artifactZip("ledger.ndjson", "x");
  dangling.writeUInt32LE(0xfffffff, centralAt(dangling) + 42); // local header offset past the end
  assert.equal(ledgerTextFromArtifactZip(dangling), undefined);
});

test("W1-T2927: a row without a task id or PR url still lands, defaulted the way the emitter defaults it", () => {
  const rows = wellFormedVerdictRows(
    JSON.stringify({ run_id: "r1", step: MUTATION_GATE_VERDICT_STEP, conclusion: "success", killed: 1, survived: 0, timeout: 0, no_coverage: 0 }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task_id, "mutation-ratchet");
  assert.equal(rows[0]!.pr_url, undefined);
});
