import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";
import { nativeGhAndJq } from "./helpers/native-gh-and-jq.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "scripts/test-tier-manifest.mjs");
type Choice = { version: number; runId: string; sourceSha: string; source: "snapshot" | "committed"; artifactId?: string; digest: string };
type Selection = { shard: number; digest: string; files: string[] };
const tier = await import(pathToFileURL(cli).href) as {
  loadInstrumentedLedger: (committed: string | undefined, snapshot: string, resolved: Choice) => { source: string; digest: string };
  validateCoverageLedgerChoice: (choice: unknown) => Choice;
  makeCoverageLedgerChoice: (raw: Buffer, identity: Omit<Choice, "version" | "digest">) => Choice;
  partitionProblems: (files: string[], selections: Selection[], digest: string) => string[];
};
const snapshot = `${JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 99, "test/b.test.ts": 1 } })}\n`;
const digest = createHash("sha256").update(snapshot).digest("hex");
const choice: Choice = { version: 1, runId: "42", sourceSha: "a".repeat(40), source: "snapshot", artifactId: "17", digest };
const workflow = () => parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const identity = { GITHUB_RUN_ID: choice.runId, GITHUB_SHA: choice.sourceSha };

function tierCli(at: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, "--root", at, ...args], {
    cwd: at, env: { ...process.env, ...identity, ...env }, encoding: "utf8", timeout: 10_000,
  });
}

function fixture(run: (at: string) => void): void {
  const at = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-coverage-ledger-`));
  try {
    mkdirSync(join(at, "scripts"));
    writeFileSync(join(at, "scripts/committed.json"), JSON.stringify({ files: { "test/a.test.ts": 1, "test/b.test.ts": 99 } }));
    writeFileSync(join(at, "snapshot.json"), snapshot);
    run(at);
  } finally { rmSync(at, { recursive: true, force: true }); }
}

test("W1-T9448: every coverage shard weighs the snapshot id its run resolved once", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const resolver = workflow.jobs["coverage-ledger"];
  assert.ok(resolver, "one always-registering job resolves the run's immutable ledger choice");
  assert.equal(resolver.if, undefined);
  assert.equal(resolver["timeout-minutes"], 1, "75 - 49 - 20 - 5 minutes remain for the producer");
  assert.ok(workflow.jobs["coverage-ratchet"].needs.includes("coverage-ledger"));
  assert.equal(workflow.jobs["coverage-ratchet"].if, undefined);
  const shardBody = workflow.jobs["coverage-ratchet"].steps.map((s: any) => s.run ?? "").join("\n");
  assert.doesNotMatch(shardBody, /actions\/artifacts\?name=test-tier-coverage-manifest-proposal/,
    "no shard independently decides whether to use a snapshot");
  assert.match(shardBody, /--resolved-ledger/);
  fixture(at => {
    const loaded = tier.loadInstrumentedLedger(join(at, "scripts/committed.json"), join(at, "snapshot.json"), choice);
    assert.equal(loaded.digest, digest, "the full advertised content digest is what every shard records");
    assert.equal(loaded.source, "snapshot");
  });
});

test("W1-T9448: a shard that cannot fetch the named snapshot fails instead of falling back", () => {
  fixture(at => {
    assert.throws(() => tier.loadInstrumentedLedger(join(at, "scripts/committed.json"), join(at, "missing.json"), choice),
      /resolved coverage ledger.*17.*unreadable/i);
    writeFileSync(join(at, "broken.json"), "not JSON");
    assert.throws(() => tier.loadInstrumentedLedger(join(at, "scripts/committed.json"), join(at, "broken.json"), choice),
      /resolved coverage ledger.*17/i);
    assert.throws(() => tier.loadInstrumentedLedger(join(at, "scripts/committed.json"), join(at, "snapshot.json"), { ...choice, digest: "0".repeat(64) }),
      /resolved coverage ledger.*digest/i);
  });
});

test("W1-T9448: a split across ledgers names the diverging shard", () => {
  const problems = tier.partitionProblems(["test/a.test.ts", "test/b.test.ts"], [
    { shard: 1, digest, files: ["test/a.test.ts"] },
    { shard: 6, digest: "committed", files: ["test/b.test.ts"] },
  ], digest);
  assert.equal(problems.length, 1, "keep partition membership checks and their problem accounting");
  assert.match(problems[0], /shards weighed different ledgers/);
  assert.match(problems[0], new RegExp(`shard 6=committed.*expected ${digest}`));
  assert.notEqual(tier.partitionProblems(["test/a.test.ts"], [{ shard: 6, digest: "committed", files: ["test/a.test.ts"] }], digest).length, 0,
    "even an internally consistent wrong ledger must not replace the advertised run choice");
});

test("the emitted ledger CLI writes once, verifies bytes and binds both run and source", () => {
  fixture(at => {
    const args = ["--resolved-ledger", "choice.json", "--snapshot", "snapshot.json"];
    const written = tierCli(at, ["--write-resolved-ledger", ...args, "--ledger-source", "snapshot", "--artifact-id", "17", "--github-output", join(at, "outputs")]);
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(at, "choice.json"), "utf8")), choice);
    assert.match(readFileSync(join(at, "outputs"), "utf8"), new RegExp(`^digest=${digest}$`, "m"));
    assert.equal(tierCli(at, ["--write-resolved-ledger", ...args, "--ledger-source", "snapshot", "--artifact-id", "17"]).status, 1,
      "an immutable choice is not overwritten");
    assert.equal(tierCli(at, ["--verify-resolved-ledger", ...args]).status, 0);
    for (const [env, message] of [
      [{ GITHUB_RUN_ID: "43" }, /another run/],
      [{ GITHUB_SHA: "b".repeat(40) }, /another source SHA/],
      [{ GITHUB_RUN_ID: "" }, /requires GITHUB_RUN_ID/],
    ] as const) {
      const rejected = tierCli(at, ["--verify-resolved-ledger", ...args], env);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, message);
    }
    writeFileSync(join(at, "snapshot.json"), "changed bytes");
    const corrupt = tierCli(at, ["--verify-resolved-ledger", ...args]);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /digest mismatch/);
    for (const altered of [null, { ...choice, version: 2 }, { ...choice, runId: 42 },
      { ...choice, artifactId: 17 }, { ...choice, digest: "short" },
      { ...choice, source: "committed" }, { ...choice, source: "other" }]) {
      assert.throws(() => tier.validateCoverageLedgerChoice(altered), /malformed/);
    }
    for (const raw of ["not JSON", '{"files":[]}', '{"files":{"test/a.test.ts":-1}}']) {
      writeFileSync(join(at, "snapshot.json"), raw);
      const corruptChoice = { ...choice, digest: createHash("sha256").update(raw).digest("hex") };
      assert.throws(() => tier.loadInstrumentedLedger(undefined, join(at, "snapshot.json"), corruptChoice), /invalid/,
        "a matching digest does not make malformed content usable");
      const refused = tierCli(at, ["--write-resolved-ledger", "--snapshot", "snapshot.json", "--resolved-ledger", "bad.json", "--ledger-source", "snapshot", "--artifact-id", "17"]);
      assert.equal(refused.status, 1);
      assert.equal(existsSync(join(at, "bad.json")), false);
    }
  });
});

test("the real strict selection CLI partitions all files on either one snapshot or one committed choice", () => {
  fixture(at => {
    mkdirSync(join(at, "test"));
    const files = Array.from({ length: 40 }, (_, i) => `test/suite-${String(i).padStart(2, "0")}.test.ts`);
    for (const name of files) writeFileSync(join(at, name), "// physical selection fixture\n");
    writeFileSync(join(at, "scripts/test-tier-manifest.json"), JSON.stringify({ files: {} }));
    const committed = JSON.stringify({ files: Object.fromEntries(files.map((f, i) => [f, i + 1])) });
    const measured = JSON.stringify({ files: Object.fromEntries(files.map((f, i) => [f, (40 - i) * 900])) });
    writeFileSync(join(at, "scripts/committed.json"), committed);
    const splits: string[][][] = [];
    const ledgers: Selection[][] = [];
    for (const source of ["snapshot", "committed"] as const) {
      writeFileSync(join(at, "snapshot.json"), source === "snapshot" ? measured : committed);
      const chosen = tier.makeCoverageLedgerChoice(readFileSync(join(at, "snapshot.json")), {
        runId: choice.runId, sourceSha: choice.sourceSha, source, ...(source === "snapshot" ? { artifactId: "17" } : {}),
      });
      writeFileSync(join(at, "choice.json"), JSON.stringify(chosen));
      const paths = [];
      const split = [];
      const records = [];
      for (let shard = 1; shard <= 8; shard++) {
        const out = `sel-${shard}.json`;
        const args = ["--select-all", "--shard", `${shard}/8`, "--instrumented-manifest", "scripts/committed.json",
          "--snapshot", "snapshot.json", "--resolved-ledger", "choice.json", "--workers", "3", "--selection-output", out];
        const selected = tierCli(at, args);
        assert.equal(selected.status, 0, selected.stderr);
        const record = JSON.parse(readFileSync(join(at, out), "utf8"));
        assert.equal(record.digest, chosen.digest);
        assert.equal(record.shard, shard);
        split.push(record.files);
        records.push(record);
        paths.push(out);
      }
      assert.deepEqual(split.flat().sort(), files);
      const partition = tierCli(at, ["--check-partition", ...paths, "--resolved-digest", chosen.digest]);
      assert.equal(partition.status, 0, partition.stderr);
      assert.match(partition.stdout, /8 coverage shard\(s\) partition all 40/);
      const wrong = tierCli(at, ["--check-partition", ...paths, "--resolved-digest", "0".repeat(64)]);
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /shard 6=.*expected/);
      assert.equal(tierCli(at, ["--check-partition", ...paths, "--resolved-digest", ""]).status, 1);
      splits.push(split);
      ledgers.push(records);
    }
    assert.notDeepEqual(splits[0], splits[1], "the control weights must produce genuinely different partitions");
    const mixed = ledgers[0]!.map((record, i) => i === 5 || i === 6 ? ledgers[1]![i]! : record);
    const problems = tier.partitionProblems(files, mixed, ledgers[0]![0]!.digest);
    assert.match(problems.join("\n"), /shard 6=.*expected/);
    assert.match(problems.join("\n"), /ran on no shard|ran on shard \d+ and shard \d+/,
      "the mixed-weight control must reproduce membership damage, not only disagreeing metadata");
    rmSync(join(at, "snapshot.json"));
    const missing = tierCli(at, ["--select-all", "--shard", "1/8", "--instrumented-manifest", "scripts/committed.json",
      "--snapshot", "snapshot.json", "--resolved-ledger", "choice.json", "--selection-output", "must-not-exist.json"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /unreadable.*refusing a different ledger/);
    assert.equal(existsSync(join(at, "must-not-exist.json")), false);
    const incomplete = tierCli(at, ["--select-all", "--shard", "1/8", "--resolved-ledger", "choice.json"]);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /requires an instrumented manifest/);
    const noChoice = tierCli(at, ["--select-all", "--shard", "1/8", "--instrumented-manifest", "scripts/committed.json", "--resolved-ledger"]);
    assert.equal(noChoice.status, 1);
    assert.match(noChoice.stderr, /requires a choice path/);
    assert.equal(tierCli(at, ["--check-partition", "sel-1.json", "--resolved-digest"]).status, 1);
  });
});

const currentArtifacts = "actions/runs/42/artifacts?per_page=100";
const proposalArtifacts = "actions/artifacts?name=test-tier-coverage-manifest-proposal";
const artifactPages = (...artifacts: object[]) => JSON.stringify({ artifacts });
const existingChoicePage = artifactPages({ id: 88, name: "coverage-ledger-choice-42" });
const defaults: GhShimRoute[] = [
  { when: currentArtifacts, stdout: artifactPages() },
  { when: "actions/runs/42 --jq", stdout: "2026-10-15T15:43:14Z" },
  { when: proposalArtifacts, stdout: artifactPages({ id: 17, expired: false, created_at: "2026-10-15T15:00:00Z" }) },
  { when: "actions/artifacts/17/zip", stdout: "fake archive; unzip is an explicit fixture port" },
  { when: "", stderr: "unexpected fake gh call", exit: 99 },
];

/** Exercise the workflow's actual shell, actual Node CLI and actual byte validation. Only external
 * API/archive ports and GNU date's cutoff conversion are fake; no network or real git repo is used. */
function shellFixture(run: (h: {
  at: string; gh: ReturnType<typeof ghShim>; git: ReturnType<typeof ghShim>; env: NodeJS.ProcessEnv;
  shell: (job: string, step: string, env?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
}) => void, routes: GhShimRoute[] = [], unzip: GhShimRoute[] | null = [
  { when: "ledger-choice.json", stdout: JSON.stringify(choice) },
  { when: "ledger-snapshot.manifest", stdout: snapshot.trimEnd() },
  { when: "test-tier-coverage-manifest.next.json", stdout: snapshot.trimEnd() },
  { when: "", stderr: "unexpected fake unzip call", exit: 99 },
]): void {
  fixture(at => {
    // The CLI's entry guard compares the physical path; copy its exact bytes, not a symlink
    // that would quietly import without executing main. Its unchanged dependency can be linked.
    copyFileSync(cli, join(at, "scripts/test-tier-manifest.mjs"));
    assert.deepEqual(readFileSync(join(at, "scripts/test-tier-manifest.mjs")), readFileSync(cli));
    for (const name of ["pure-test-pool.mjs", "diff-class.mjs"]) symlinkSync(join(root, "scripts", name), join(at, "scripts", name));
    writeFileSync(join(at, "scripts/test-tier-coverage-manifest.json"), snapshot);
    mkdirSync(join(at, "runner"));
    const gh = ghShim([{ when: "--slurp --jq", stderr: "the --slurp option is not supported with --jq", exit: 1 }, ...routes, ...defaults]);
    const git = ghShim([{ when: "diff --name-only", stdout: "src/lib/tmp.ts" }, { when: "", exit: 99 }], { command: "git" });
    const date = ghShim([{ when: "", stdout: "2026-10-15T15:33:14Z" }], { command: "date" });
    const archive = unzip === null ? undefined : ghShim(unzip, { command: "unzip" });
    const owned = [gh, git, date, ...(archive ? [archive] : [])];
    const env = { ...process.env, ...identity, GITHUB_REPOSITORY: "fixture/repo", GITHUB_EVENT_NAME: "pull_request",
      GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: join(at, "runner"), GITHUB_OUTPUT: join(at, "outputs"),
      PATH: [...owned.map(s => s.dir), dirname(process.execPath), process.env.PATH].join(":"),
      LEDGER_ARTIFACT_ID: "88", LEDGER_DIGEST: digest };
    try {
      run({ at, gh, git, env, shell: (job, step, overrides = {}) => {
        const body = workflow().jobs[job].steps.find((s: { name?: string }) => s.name?.includes(step))?.run;
        assert.equal(typeof body, "string", `physical workflow shell ${job}/${step} must exist`);
        const actual = body.replace(/\$\{\{\s*steps\.classify\.outputs\.class\s*\}\}/g, overrides.FIXTURE_CLASS ?? "SOURCE");
        return spawnSync("/bin/bash", ["-c", actual], { cwd: at, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000 });
      } });
    } finally { for (const shim of owned) rmSync(shim.dir, { recursive: true, force: true }); }
  });
}

test("the resolver shell distinguishes API errors from a successful empty lookup", () => {
  for (const when of [currentArtifacts, "actions/runs/42 --jq", proposalArtifacts]) {
    shellFixture(h => {
      const refused = h.shell("coverage-ledger", "Resolve one immutable");
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /coverage-ledger: (cannot read|cannot enumerate)/);
      assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json")), false);
    }, [{ when, stderr: "fixture API unreadable", exit: 1 }]);
  }
  shellFixture(h => {
    const result = h.shell("coverage-ledger", "Resolve one immutable");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /successful lookup found no eligible proposal/);
    const emitted = JSON.parse(readFileSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json"), "utf8"));
    assert.equal(emitted.source, "committed");
    assert.equal(emitted.artifactId, undefined);
    assert.equal(emitted.digest, digest);
    assert.ok(h.gh.calls().every(c => !c.includes("/zip")), "confirmed absence alone chooses committed, with no download fallback");
  }, [{ when: proposalArtifacts, stdout: artifactPages() }]);
  for (const when of [currentArtifacts, proposalArtifacts]) {
    shellFixture(h => {
      const malformed = h.shell("coverage-ledger", "Resolve one immutable");
      assert.equal(malformed.status, 1, malformed.stderr);
      assert.match(malformed.stderr, /coverage-ledger: (cannot read|cannot enumerate)/);
      assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json")), false);
    }, [{ when, stdout: "not JSON" }]);
  }
});

function lookupParts(name: "EXISTING" | "LEDGER_ID", body: string) {
  const startToken = `${name}="$(gh api `;
  const start = body.indexOf(startToken);
  assert.ok(start >= 0, `${name} must come from the emitted gh command`);
  const end = body.indexOf(')" \\\n', start);
  assert.ok(end > start, `${name} must retain its refusing command substitution`);
  const command = body.slice(start + `${name}="$(`.length, end).replace(/\\\n/g, " ");
  const parsed = /^gh api "[^"]+"\s+([^]*?)\s+(--jq|\|\s*jq\s+(-sr|-r))\s+"([^]*)"\s*$/.exec(command);
  assert.ok(parsed, `${name} must expose the actual CLI flags and global JSON query`);
  const query = parsed[4]!.replaceAll('\\"', '"')
    .replaceAll("${CHOICE_NAME}", "coverage-ledger-choice-42").replaceAll("${CUTOFF}", "2026-10-15T15:33:14Z");
  assert.doesNotMatch(query, /\$\{/);
  return { flags: parsed[1]!.trim().split(/\s+/), query, embedded: parsed[2] === "--jq", jqFlag: parsed[3] };
}

test("real gh pagination and external jq resolve the emitted global ledger queries over loopback", async () => {
  const { gh, jq } = nativeGhAndJq();
  const at = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ledger-http-`));
  const requests = join(at, "requests");
  writeFileSync(requests, "");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GH_TOKEN: "w9448-loopback-synthetic", GH_ENTERPRISE_TOKEN: "w9448-loopback-synthetic",
    GH_CONFIG_DIR: at, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", CI: "true" };
  const server = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createServer} from 'node:http';
    import {appendFileSync} from 'node:fs';
    const server=createServer((req,res)=>{
      const url=new URL(req.url,'http://'+req.headers.host); const page=Number(url.searchParams.get('page')??1);
      appendFileSync(process.argv[1],url.pathname+'?page='+page+'\\n');
      if(url.pathname==='/broken'&&page===2){res.writeHead(503);res.end('fixture API unreadable');return;}
      if(url.pathname==='/malformed'){res.writeHead(200,{'content-type':'application/json'});res.end('not JSON');return;}
      const current=(id)=>({id,name:'coverage-ledger-choice-42'});
      const proposal=(id,time,expired=false)=>({id,created_at:'2026-10-15T'+time+'Z',expired});
      let artifacts=[];
      if(url.pathname==='/choice')artifacts=page===1?[{id:1,name:'other'}]:[current(88)];
      if(url.pathname==='/duplicate')artifacts=[current(page===1?88:99)];
      if(url.pathname==='/proposal')artifacts=page===1?[proposal(29,'15:20:00'),proposal(100,'15:34:00')]:[proposal(17,'15:00:00'),proposal(99,'15:32:00',true)];
      const headers={'content-type':'application/json'};
      if(page===1)headers.link='<http://'+req.headers.host+url.pathname+'?page=2>; rel="next"';
      res.writeHead(200,headers);res.end(JSON.stringify({artifacts}));
    });
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
  `, requests], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = once(server, "close").catch(() => undefined);
  let errors = "";
  server.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096); });
  let startup: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      startup = setTimeout(() => reject(new Error(`loopback fixture readiness timed out: ${errors}`)), 10_000);
      server.once("error", reject);
      server.once("exit", () => reject(new Error(`loopback fixture exited before readiness: ${errors}`)));
      server.once("message", message => {
        const port = (message as { port?: number }).port;
        if (!Number.isInteger(port) || !port || port < 1 || port > 65535) reject(new Error("invalid fixture port"));
        else resolve(port);
      });
    });
    clearTimeout(startup);
    const endpoint = (path: string) => `http://127.0.0.1:${port}${path}`;
    const ghVersion = spawnSync(gh, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
    const jqVersion = spawnSync(jq, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
    assert.match(ghVersion.stdout, /^gh version /); assert.match(jqVersion.stdout, /^jq-/);
    const rejected = spawnSync(gh, ["api", endpoint("/choice"), "--paginate", "--slurp", "--jq", "."], { env, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--slurp.*not supported.*--jq|unknown flag: --slurp/);
    assert.equal(readFileSync(requests, "utf8"), "", "the real CLI rejects the old flags before any HTTP call");
    const body = workflow().jobs["coverage-ledger"].steps.find((s: { id?: string }) => s.id === "resolve").run as string;
    const run = (name: "EXISTING" | "LEDGER_ID", path: string) => {
      const parts = lookupParts(name, body);
      const pages = spawnSync(gh, ["api", endpoint(path), ...parts.flags, ...(parts.embedded ? ["--jq", parts.query] : [])], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(pages.error, undefined); assert.equal(pages.signal, null);
      if (pages.status !== 0 || parts.embedded) return pages;
      assert.ok(parts.jqFlag);
      const filtered = spawnSync(jq, [parts.jqFlag, parts.query], { env, input: pages.stdout, encoding: "utf8", timeout: 10_000 });
      assert.equal(filtered.error, undefined); assert.equal(filtered.signal, null);
      return filtered;
    };
    for (const [name, path, expected] of [["EXISTING", "/choice", "88"], ["LEDGER_ID", "/proposal", "29"],
      ["EXISTING", "/empty", ""], ["LEDGER_ID", "/empty", ""]] as const) {
      const selected = run(name, path);
      assert.equal(selected.status, 0, selected.stderr);
      assert.equal(selected.stdout.trim(), expected, "filter all pages together, never take one runner's last page");
    }
    const duplicate = run("EXISTING", "/duplicate");
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /multiple run ledger choices/);
    for (const name of ["EXISTING", "LEDGER_ID"] as const) {
      for (const path of ["/broken", "/malformed"]) {
        const unreadable = run(name, path);
        assert.notEqual(unreadable.status, 0, "API/content errors are not successful empty lookups");
      }
    }
    const calls = readFileSync(requests, "utf8");
    assert.match(calls, /\/choice\?page=2/); assert.match(calls, /\/proposal\?page=2/);
    for (const name of ["EXISTING", "LEDGER_ID"] as const) {
      assert.deepEqual(lookupParts(name, body).flags, ["--paginate"], "both native CLI versions support the emitted pagination flags");
      assert.equal(lookupParts(name, body).jqFlag, "-sr", "external jq slurps the complete per-page JSON stream exactly once");
    }
  } finally {
    clearTimeout(startup);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    const backstop = setTimeout(() => server.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(backstop); rmSync(at, { recursive: true, force: true }); }
  }
});

test("the resolver shell publishes one snapshot and refuses selected-archive failures", () => {
  shellFixture(h => {
    const resolved = h.shell("coverage-ledger", "Resolve one immutable");
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json"), "utf8")), choice);
    const missingUpload = h.shell("coverage-ledger", "Require the published", { DIGEST: digest, EXISTING_ID: "", PUBLISHED_ID: "" });
    assert.equal(missingUpload.status, 1);
    const finish = h.shell("coverage-ledger", "Require the published", { DIGEST: digest, EXISTING_ID: "", PUBLISHED_ID: "88" });
    assert.equal(finish.status, 0, finish.stderr);
    assert.match(readFileSync(join(h.at, "outputs"), "utf8"), /^artifact_id=88$/m);
    const publish = workflow().jobs["coverage-ledger"].steps.find((s: { id?: string }) => s.id === "publish");
    assert.equal(publish.with.overwrite, undefined, "a rerun must never delete and replace the choice's artifact id");
  });
  shellFixture(h => {
    const result = h.shell("coverage-ledger", "Resolve one immutable");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot download selected proposal artifact 17/);
    assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json")), false);
  }, [{ when: "actions/artifacts/17/zip", stderr: "404", exit: 1 }]);
  shellFixture(h => {
    const result = h.shell("coverage-ledger", "Resolve one immutable");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /selected proposal artifact 17 has no ledger/);
  }, [], null); // Real unzip rejects fake bytes; this is not a stubbed success assertion.
  shellFixture(h => {
    const malformed = h.shell("coverage-ledger", "Resolve one immutable");
    assert.equal(malformed.status, 1, malformed.stderr);
    assert.match(malformed.stderr, /test-tier-manifest:/);
    assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish/ledger-choice.json")), false);
  }, [], [{ when: "", stdout: "bad JSON" }]);
});

test("the actual consumer retries only the chosen id and fails before install, never resolving a replacement", () => {
  const steps = workflow().jobs["coverage-ratchet"].steps;
  const consumer = steps.findIndex((s: { name?: string }) => s.name?.includes("Require the run's resolved"));
  const install = steps.findIndex((s: { run?: string }) => s.run?.includes("npm ci"));
  assert.ok(consumer >= 0 && consumer < install, "named download failures precede heavy setup");
  shellFixture(h => {
    const result = h.shell("coverage-ratchet", "Require the run's resolved");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot download resolved artifact 88.*before setup/);
    assert.equal(h.gh.calls().length, 2);
    assert.ok(h.gh.calls().every(c => c.includes("actions/artifacts/88/zip")));
    assert.equal(existsSync(join(h.at, "coverage/ledger-choice.json")), false);
  }, [{ when: "actions/artifacts/88/zip", stderr: "404", exit: 1 }]);
  shellFixture(h => {
    const result = h.shell("coverage-ratchet", "Require the run's resolved");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(h.gh.calls().length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(h.at, "coverage/ledger-choice.json"), "utf8")), choice);
    const wrong = h.shell("coverage-ratchet", "Require the run's resolved", { LEDGER_DIGEST: "0".repeat(64) });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /differs from the run's advertised digest/);
  }, [{ when: "actions/artifacts/88/zip", stdout: "fake archive" }]);
  shellFixture(h => {
    const missingIdentity = h.shell("coverage-ratchet", "Require the run's resolved", { LEDGER_ARTIFACT_ID: "" });
    assert.equal(missingIdentity.status, 1);
    assert.match(missingIdentity.stderr, /no resolved artifact id/);
    const missingDigest = h.shell("coverage-ratchet", "Require the run's resolved", { LEDGER_DIGEST: "" });
    assert.equal(missingDigest.status, 1);
    assert.match(missingDigest.stderr, /no resolved content digest/);
    assert.deepEqual(h.gh.calls(), []);
  });
});

test("reruns reuse the validated immutable run artifact and never rechoose a missing one", () => {
  shellFixture(h => {
    const reused = h.shell("coverage-ledger", "Resolve one immutable", { GITHUB_RUN_ATTEMPT: "2" });
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish")), false, "reuse produces no replacement upload directory");
    assert.match(readFileSync(join(h.at, "outputs"), "utf8"), /^existing_artifact_id=88$/m);
    assert.equal(h.gh.calls().length, 2);
    assert.ok(h.gh.calls().every(c => !c.includes(proposalArtifacts)));
    const finish = h.shell("coverage-ledger", "Require the published", { DIGEST: digest, EXISTING_ID: "88", PUBLISHED_ID: "" });
    assert.equal(finish.status, 0, finish.stderr);
  }, [{ when: currentArtifacts, stdout: existingChoicePage }, { when: "actions/artifacts/88/zip", stdout: "fake archive" }]);
  shellFixture(h => {
    const lost = h.shell("coverage-ledger", "Resolve one immutable", { GITHUB_RUN_ATTEMPT: "2" });
    assert.equal(lost.status, 1);
    assert.match(lost.stderr, /immutable choice is unavailable.*never replace/);
    assert.equal(h.gh.calls().length, 1);
  });
  shellFixture(h => {
    const wrongSource = h.shell("coverage-ledger", "Resolve one immutable", { GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "b".repeat(40) });
    assert.equal(wrongSource.status, 1);
    assert.match(wrongSource.stderr, /another source SHA/);
    assert.equal(existsSync(join(h.at, "runner/coverage-ledger-publish")), false);
    assert.ok(h.gh.calls().every(c => !c.includes(proposalArtifacts)));
  }, [{ when: currentArtifacts, stdout: existingChoicePage }, { when: "actions/artifacts/88/zip", stdout: "fake archive" }]);
  shellFixture(h => {
    const lost = h.shell("coverage-ledger", "Resolve one immutable", { GITHUB_RUN_ATTEMPT: "2" });
    assert.equal(lost.status, 1);
    assert.match(lost.stderr, /cannot download already-published choice artifact 88/);
    assert.ok(h.gh.calls().every(c => !c.includes(proposalArtifacts)));
  }, [{ when: currentArtifacts, stdout: existingChoicePage }, { when: "actions/artifacts/88/zip", stderr: "404", exit: 1 }]);
});

test("the actual consumer rejects malformed content, identities and bytes before setup", () => {
  for (const [identityText, ledgerText, message] of [
    ["not JSON", snapshot, /test-tier-manifest:/],
    [JSON.stringify({ ...choice, version: 2 }), snapshot, /malformed/],
    [JSON.stringify({ ...choice, runId: "43" }), snapshot, /another run/],
    [JSON.stringify({ ...choice, sourceSha: "b".repeat(40) }), snapshot, /another source SHA/],
    [JSON.stringify(choice), "different ledger", /digest mismatch/],
    [JSON.stringify({ ...choice, digest: createHash("sha256").update("bad\n").digest("hex") }), "bad\n", /invalid/],
  ] as const) {
    shellFixture(h => {
      const result = h.shell("coverage-ratchet", "Require the run's resolved");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
      assert.equal(h.gh.calls().length, 1, "validation never resolves another ledger");
    }, [{ when: "actions/artifacts/88/zip", stdout: "fake archive" }], [
      { when: "ledger-choice.json", stdout: identityText },
      { when: "ledger-snapshot.manifest", stdout: ledgerText.trimEnd() },
      { when: "", exit: 99 },
    ]);
  }
  shellFixture(h => {
    const result = h.shell("coverage-ratchet", "Require the run's resolved");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolved artifact 88 has no choice identity/);
  }, [{ when: "actions/artifacts/88/zip", stdout: "bad archive" }], null);
});

test("both emitted shells preserve non-source, push and merge-group no-collection lanes", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch"]) {
    shellFixture(h => {
      assert.equal(h.shell("coverage-ledger", "Resolve one immutable", { GITHUB_EVENT_NAME: event }).status, 0);
      assert.equal(h.shell("coverage-ratchet", "Require the run's resolved", { GITHUB_EVENT_NAME: event }).status, 0);
      assert.deepEqual(h.gh.calls(), []);
    });
  }
  for (const category of ["PLAN_ONLY", "DOCS_ONLY", "TEST_ONLY", "NO_SRC"]) {
    shellFixture(h => {
      assert.equal(h.shell("coverage-ratchet", "Require the run's resolved", { FIXTURE_CLASS: category }).status, 0);
      assert.equal(h.shell("coverage-ledger", "Require the published", { DIGEST: "" }).status, 0);
      assert.deepEqual(h.gh.calls(), []);
    });
  }
  for (const path of ["docs/ledger.md", "test/unrelated.test.ts", "plan/tasks.d/W1-T1.yaml"]) {
    shellFixture(h => {
      h.git.addRoute({ when: "diff --name-only", stdout: path });
      const result = h.shell("coverage-ledger", "Resolve one immutable");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no instrumented split/);
      assert.deepEqual(h.gh.calls(), []);
    });
  }
});


test("the coverage ledger sparse checkout runs its real classifier before dependencies exist", () => {
  const ledger = workflow().jobs["coverage-ledger"];
  const checkout = ledger.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
  const paths = (checkout.with["sparse-checkout"] as string).split("\n").map(path => path.trim()).filter(Boolean);
  const assignment = (ledger.steps.find((step: any) => step.id === "resolve").run as string)
    .split("\n").find(line => line.startsWith('CLASS="'))!;
  assert.ok(assignment, "exercise the workflow's actual fail-closed classifier assignment");
  fixture(at => {
    const archive = join(at, "sparse-inputs.tar");
    const packed = spawnSync("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD", ...paths],
      { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const unpacked = spawnSync("tar", ["-xf", archive, "-C", at], { encoding: "utf8" });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.equal(existsSync(join(at, "node_modules")), false, "the sparse job classifies before npm install");
    // A shell classifier must not borrow the parent's test loader through NODE_OPTIONS.
    const env = { ...process.env, NODE_OPTIONS: "" };
    const classify = (changed: string) => {
      writeFileSync(join(at, "ledger-changed-files.txt"), `${changed}\n`);
      return spawnSync(process.execPath, ["scripts/diff-class.mjs", "--coverage-class", "--changed-files", "ledger-changed-files.txt"],
        { cwd: at, env, encoding: "utf8" });
    };
    for (const [changed, expected] of [
      ["plan/tasks.d/example.yaml", "PLAN_ONLY"], ["docs/example.md", "DOCS_ONLY"],
      ["test/example.test.ts", "TEST_ONLY"], ["src/lib/example.ts", "SOURCE"],
      [".github/workflows/ci.yml", "SOURCE"],
    ]) {
      const result = classify(changed!);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected, changed);
    }
    rmSync(join(at, "src/lib/rule-suites.ts"));
    writeFileSync(join(at, "ledger-changed-files.txt"), "plan/tasks.d/example.yaml\n");
    const refused = spawnSync("bash", ["-c", `${assignment}\nprintf '%s\\n' "$CLASS"`],
      { cwd: at, env, encoding: "utf8" });
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(refused.stdout.trim(), "SOURCE", "an unavailable classifier still measures conservatively");
    assert.match(refused.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(join(at, "node_modules")), false);
  });
});
