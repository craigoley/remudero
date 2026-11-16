/**
 * W1-T13177 — the off-host heartbeat watcher raises a daemon container whose restart budget is
 * spent: `AT_LIMIT` or `STOPPED_RETRY_EXHAUSTED` on a fresh beat.
 *
 * OBSERVED 2026-09-05T08:40Z (W1-T2874). Docker reported `remudero-daemon state=exited exit=134
 * restart=5 policy=on-failure max=5`. The beat a minute later was fresh and said
 * `daemon_verdict=live`, because the newest ledger row was 434 s old. Docker made no sixth restart
 * and the watcher saw a fresh beat and raised nothing. Since #5407 (W1-T3411) the beat names that
 * state in `restart_verdict`. Until this task, .github/workflows/fleet-heartbeat-watch.yml never
 * read the field.
 *
 * WHAT THIS SUITE DRIVES. The committed workflow's own step bodies, extracted from the YAML and
 * run under bash, the way test/fleet-heartbeat.test.ts drives the judging and delivery steps:
 *   - the judging step, against per-branch beat payloads served by a `git` stand-in;
 *   - the delivery step, through the REAL scripts/needs-human-issue.mjs with the shared PATH shim
 *     (#test/helpers/gh-shim.js) standing in for the GitHub CLI, so the idempotence asserted
 *     here is that script's own marker dedup, not a re-implementation of it;
 *   - the self-check step's predicate half (everything before its `# (ii)` section). The rest of
 *     that step runs the real beat about thirty times and needs GNU `date -d`; only the hosted
 *     run on a pull request touching the workflow executes it.
 * Criterion 2's payload is the REAL beat's output (#test/helpers/fleet-heartbeat-harness.js) for
 * a live ledger beside a container docker reports exited 134 at 5 of 5.
 *
 * THE RESTART RECORD STANDS BESIDE THE LIVENESS RECORD. The liveness record is chosen by a
 * first-match `elif` chain (W1-T3367), where an earlier arm masks a later one. So the restart
 * finding is judged outside that chain and delivered under its own source,
 * `fleet-heartbeat:<branch>:restart`. Neither record's raise or resolve touches the other.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { runBeat } from "#test/helpers/fleet-heartbeat-harness.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "fleet-heartbeat-watch.yml");
const SELF_CHECK = "Self-check";
const JUDGE = "Read every host beat branch and judge each age";
const DELIVER = "Deliver or resolve one needs-human issue per host";

/** The restart predicate as committed, in both the self-check and the judging step. */
const PREDICATE = 'is_restart_spent() { case "$1" in AT_LIMIT*|STOPPED_RETRY_EXHAUSTED*) return 0 ;; *) return 1 ;; esac; }';
const NEVER_RAISES = "is_restart_spent() { return 1; }";
const RAISES_ON_OK = 'is_restart_spent() { case "$1" in AT_LIMIT*|STOPPED_RETRY_EXHAUSTED*|ok*) return 0 ;; *) return 1 ;; esac; }';

/** The `run: |` body of the step whose name starts with `name`, dedented. Loud on any miss. */
function stepBody(name: string): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const starts = lines.flatMap((l, i) => (l.trim().startsWith(`- name: ${name}`) ? [i] : []));
  assert.equal(starts.length, 1, `exactly one step named "${name}…" must exist, found ${starts.length}`);
  const runAt = lines.findIndex((l, i) => i > starts[0] && l.trim() === "run: |");
  assert.ok(runAt > starts[0], `the step "${name}" no longer opens a literal \`run: |\` block`);
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    if (!l.startsWith(" ".repeat(10))) break;
    body.push(l.slice(10));
  }
  const script = body.join("\n");
  assert.ok(script.split("\n").length > 10, `the extracted "${name}" step is empty`);
  return script;
}

function mutateOnce(script: string, mutate?: [string, string]): string {
  if (!mutate) return script;
  const [find, replace] = mutate;
  const n = script.split(find).length - 1;
  assert.equal(n, 1, `mutation target must be UNIQUE in the step, found ${n}: ${find}`);
  return script.replace(find, replace);
}

// ── beat payloads ─────────────────────────────────────────────────────────────────────────────

/** A healthy beat's liveness lines, every arm of the W1-T3367 chain reading clean. */
const HEALTHY: Record<string, string> = {
  daemon_verdict: "live",
  supervisor_verdict: "live",
  dispatch_verdict: "building",
  escalation_spool_verdict: "ok",
  crash_loop_verdict: "ok",
  session_reaper_verdict: "ok — sessions 6 (closing 0, orphans 0)",
};

/** A payload with the restart lines the beat publishes for `verdict` (`null`: no restart_verdict
 *  line at all, the shape of a beat older than #5407). */
function payloadOf(verdict: string | null, liveness: Record<string, string> = {}): string {
  const fields: Record<string, string> = { beat_ts: "2026-09-05T08:40:01Z", ...HEALTHY, ...liveness };
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  lines.push("restart_source=docker inspect remudero-daemon");
  if (verdict !== null) lines.push(`restart_verdict=${verdict}`);
  lines.push("restart_container=remudero-daemon", "restart_count=5", "restart_max=5", "restart_policy=on-failure");
  return lines.join("\n") + "\n";
}

// ── the judging step ──────────────────────────────────────────────────────────────────────────

/** A `git` answering the four subcommands the judging step reaches, from `$STUB_BEATS/<branch>/`. */
const GIT_STAND_IN = [
  "#!/usr/bin/env bash",
  'sub="$1"; shift',
  'd="$STUB_BEATS"',
  'case "$sub" in',
  "  ls-remote)",
  '    b="${@: -1}"',
  '    if [ -d "$d/$b" ]; then printf "%s\\trefs/heads/%s\\n" 0000000000000000000000000000000000000000 "$b"; fi',
  "    ;;",
  "  fetch) : ;;",
  "  log)",
  '    fmt=""; ref=""',
  '    for a in "$@"; do case "$a" in --format=*) fmt="${a#--format=}" ;; origin/*) ref="${a#origin/}" ;; esac; done',
  '    if [ "$fmt" = "%ct" ]; then printf "%s\\n" "$(( $(date -u +%s) - $(cat "$d/$ref/age") ))"',
  '    else printf "heartbeat: %s reporting\\n" "$ref"; fi',
  "    ;;",
  '  show) ref="${1%%:*}"; ref="${ref#origin/}"; cat "$d/$ref/heartbeat.txt" ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

interface Host {
  payload: string;
  /** Seconds since the beat; default one minute (fresh). */
  age?: number;
}

interface Judged {
  status: number;
  stdout: string;
  stderr: string;
  /** The step's working directory, which the delivery step then runs in. */
  work: string;
  /** branch -> liveness kind, from heartbeat-state.tsv. */
  liveness: Record<string, string>;
  /** branch -> restart state, from heartbeat-restart.tsv (empty when the step writes none). */
  restart: Record<string, string>;
  /** branch -> the liveness record's body. */
  bodies: Record<string, string>;
  /** branch -> the restart record's body. */
  restartBodies: Record<string, string>;
}

function tsvMap(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const [branch, state] = line.split("\t");
    out[branch] = state;
  }
  return out;
}

function judge(t: TestContext, hosts: Record<string, Host>, opts: { expected?: string; mutate?: [string, string] } = {}): Judged {
  const dir = ownedFixtureDir(t, "w1t13177-watch").dir;
  const bin = join(dir, "bin");
  const beats = join(dir, "beats");
  const work = join(dir, "work");
  for (const d of [bin, beats, work]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "git"), GIT_STAND_IN, { mode: 0o755 });
  for (const [branch, host] of Object.entries(hosts)) {
    mkdirSync(join(beats, branch));
    writeFileSync(join(beats, branch, "age"), String(host.age ?? 60));
    writeFileSync(join(beats, branch, "heartbeat.txt"), host.payload);
  }
  const script = join(dir, "judge.sh");
  writeFileSync(script, mutateOnce(stepBody(JUDGE), opts.mutate));
  const r = spawnSync("bash", [script], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HEARTBEAT_BRANCHES: Object.keys(hosts).join(" "),
      STALE_AFTER_MINUTES: "30",
      DAEMON_EXPECTED_BRANCHES: opts.expected ?? Object.keys(hosts).join(" "),
      STUB_BEATS: beats,
    },
  });
  const read = (name: string): string => (existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8") : "");
  const bodies: Record<string, string> = {};
  const restartBodies: Record<string, string> = {};
  for (const branch of Object.keys(hosts)) {
    bodies[branch] = read(`heartbeat-branch-${branch}.txt`);
    restartBodies[branch] = read(`heartbeat-restart-${branch}.txt`);
  }
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    work,
    liveness: tsvMap(join(work, "heartbeat-state.tsv")),
    restart: tsvMap(join(work, "heartbeat-restart.tsv")),
    bodies,
    restartBodies,
  };
}

// ── the delivery step, through the real needs-human-issue.mjs ─────────────────────────────────

interface OpenIssue {
  number: number;
  /** The needs-human source whose marker the issue body carries. */
  source: string;
}

interface IssueCall {
  verb: string;
  /** The first line of the call: verb, number or title. */
  head: string;
  /** The whole call, body included. */
  text: string;
}

interface Delivered {
  status: number;
  stderr: string;
  calls: IssueCall[];
  /** The needs-human source of every `issue create`, in order. */
  created: string[];
}

/** Run the committed delivery step in the judging step's directory. Open issues are what the
 *  shim's `issue list` answers; the real script decides create, comment or close from them. */
function deliver(t: TestContext, judged: Judged, open: OpenIssue[] = []): Delivered {
  const shim = ghShim(
    [
      { when: "issue list", stdoutFile: join(judged.work, "open-issues.json") },
      { when: "issue create", stdout: "https://example.invalid/issues/900" },
    ],
    { kind: "w1t13177-issues" },
  );
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  writeFileSync(
    join(judged.work, "open-issues.json"),
    JSON.stringify(open.map((i) => ({ number: i.number, title: `open ${i.source}`, body: `<!-- needs-human:${i.source} -->\nolder report` }))),
  );
  if (!existsSync(join(judged.work, "scripts"))) symlinkSync(join(REPO_ROOT, "scripts"), join(judged.work, "scripts"));
  const script = join(dirname(judged.work), "deliver.sh");
  writeFileSync(script, stepBody(DELIVER));
  const r = spawnSync("bash", [script], {
    cwd: judged.work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim.dir}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  });
  const calls: IssueCall[] = [];
  for (const line of shim.calls()) {
    const m = /^issue (list|create|comment|close|edit|view) ?/.exec(line);
    if (m) calls.push({ verb: m[1], head: line, text: line });
    else if (calls.length > 0) calls[calls.length - 1].text += `\n${line}`;
  }
  // POSITIVE CONTROL: the step reached the real script, which always lists open issues first.
  assert.ok(calls.some((c) => c.verb === "list"), `the delivery step never reached needs-human-issue.mjs: ${r.stderr}`);
  const created = calls
    .filter((c) => c.verb === "create")
    .map((c) => /<!-- needs-human:(\S+) -->/.exec(c.text)?.[1] ?? "(no marker)");
  return { status: r.status ?? -1, stderr: r.stderr ?? "", calls, created };
}

const acted = (d: Delivered, verb: "comment" | "close"): number[] =>
  d.calls.filter((c) => c.verb === verb).map((c) => Number(/^issue \w+ (\d+)/.exec(c.head)?.[1]));

// ── criterion 1 ───────────────────────────────────────────────────────────────────────────────

test("W1-T13177 criterion 1: AT_LIMIT on one host and STOPPED_RETRY_EXHAUSTED on another each raise that host's own restart record, both are judged before the step fails, and a second run files nothing new", (t) => {
  const hosts = { "heartbeat-a": { payload: payloadOf("AT_LIMIT") }, "heartbeat-b": { payload: payloadOf("STOPPED_RETRY_EXHAUSTED") } };
  const first = judge(t, hosts);
  assert.equal(first.status, 1, `a spent budget must fail the judging step:\n${first.stdout}\n${first.stderr}`);
  assert.deepEqual(first.restart, { "heartbeat-a": "SPENT", "heartbeat-b": "SPENT" }, "both hosts must be judged on their restart verdict");
  assert.match(first.stderr, /RESTART BUDGET SPENT — 'heartbeat-a': AT_LIMIT/);
  assert.match(first.stderr, /RESTART BUDGET SPENT — 'heartbeat-b': STOPPED_RETRY_EXHAUSTED/);
  assert.deepEqual(first.liveness, { "heartbeat-a": "FRESH", "heartbeat-b": "FRESH" }, "the liveness chain alone sees nothing on these beats");
  assert.match(first.restartBodies["heartbeat-b"], /STOPPED_RETRY_EXHAUSTED/);
  for (const line of ["restart_count=5", "restart_max=5", "restart_policy=on-failure"]) {
    assert.ok(first.restartBodies["heartbeat-a"].includes(line), `the restart record's body must carry ${line}`);
  }

  const raised = deliver(t, first);
  assert.equal(raised.status, 0, raised.stderr);
  assert.deepEqual(raised.created, ["fleet-heartbeat:heartbeat-a:restart", "fleet-heartbeat:heartbeat-b:restart"], "one restart record per host, under its own source");
  const titles = raised.calls.filter((c) => c.verb === "create").map((c) => c.head);
  assert.match(titles[0], /--title fleet-heartbeat \(heartbeat-a\): the daemon container's restart budget is spent/);
  assert.match(titles[1], /--title fleet-heartbeat \(heartbeat-b\): the daemon container's restart budget is spent/);

  // A second hourly run over the same beats, with run 1's issues now open, files nothing new.
  const again = deliver(t, judge(t, hosts), raised.created.map((source, i) => ({ number: 700 + i, source })));
  assert.deepEqual(again.created, [], "the same spent budget must append to its open record, never open a second one");
  assert.deepEqual(acted(again, "comment"), [700, 701]);
  assert.deepEqual(acted(again, "close"), []);
});

// ── criterion 2 ───────────────────────────────────────────────────────────────────────────────

/** A container runtime that answers an `inspect --format` template by field name, whatever order
 *  the beat asks for them in: docker's own answer for `remudero-daemon` on 2026-09-05. */
const EXITED_134_AT_CAP = [
  'fmt=""; prev=""',
  'for a in "$@"; do case "$a" in --format=*) fmt="${a#--format=}" ;; esac; [ "$prev" = "--format" ] && fmt="$a"; prev="$a"; done',
  '[ -n "$fmt" ] || exit 0',
  "printf '%s\\n' \"$fmt\" | sed -e 's/{{\\.RestartCount}}/5/g' -e 's/{{\\.HostConfig\\.RestartPolicy\\.MaximumRetryCount}}/5/g' \\",
  "  -e 's/{{\\.HostConfig\\.RestartPolicy\\.Name}}/on-failure/g' -e 's/{{\\.State\\.Status}}/exited/g' \\",
  "  -e 's/{{\\.State\\.Running}}/false/g' -e 's/{{\\.State\\.ExitCode}}/134/g'",
  "",
].join("\n");

let incidentBeat: string | undefined;
/** The real beat's payload for a live ledger beside a container exited 134 at 5 of 5 on-failure. */
function incidentPayload(): string {
  if (incidentBeat !== undefined) return incidentBeat;
  const now = new Date(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const beat = runBeat({
    ledger: [
      `{"ts":"${ago(9_000_000)}","step":"daemon.boot","head_sha":"0123456789abcdef0123456789abcdef01234567"}`,
      // 434 s old, inside the beat's 600 s window: the reading that said `live` on 2026-09-05.
      `{"ts":"${ago(434_000)}","step":"daemon.alive","tick":3,"poll_interval_ms":60000}`,
    ],
    dockerStub: EXITED_134_AT_CAP,
  });
  assert.equal(beat.status, 0, beat.stderr);
  incidentBeat = beat.published;
  return incidentBeat;
}

test("W1-T13177 criterion 2: the 2026-09-05 beat (fresh, daemon live, STOPPED_RETRY_EXHAUSTED at 5 of 5 on-failure) fails the judging step, and with the restart predicate removed it passes, which is the defect", (t) => {
  const payload = incidentPayload();
  // POSITIVE CONTROL: the fixture really is the incident's shape, published by the real beat.
  for (const line of ["daemon_verdict=live", "restart_verdict=STOPPED_RETRY_EXHAUSTED", "restart_count=5", "restart_max=5", "restart_policy=on-failure"]) {
    assert.ok(payload.split("\n").includes(line), `the real beat must publish ${line}; got:\n${payload}`);
  }
  const host = { "heartbeat-azure": { payload } };

  const committed = judge(t, host);
  assert.equal(committed.status, 1, `the incident beat must fail the judging step:\n${committed.stdout}\n${committed.stderr}`);
  assert.equal(committed.liveness["heartbeat-azure"], "FRESH", "the liveness chain sees a healthy host, which is the gap");
  assert.equal(committed.restart["heartbeat-azure"], "SPENT");

  const without = judge(t, host, { mutate: [PREDICATE, NEVER_RAISES] });
  assert.equal(without.status, 0, "with no restart predicate the incident beat passes the watcher, the 2026-09-05 silence");
  assert.notEqual(without.restart["heartbeat-azure"], "SPENT");
});

// ── criterion 3 ───────────────────────────────────────────────────────────────────────────────

/** The self-check step up to its `# (ii)` section: every predicate check, none of the beat runs. */
function runSelfCheckPredicates(t: TestContext, mutate?: [string, string]): { status: number; stdout: string; stderr: string } {
  const body = stepBody(SELF_CHECK);
  const cutAt = "# (ii) the beat script parses";
  assert.equal(body.split(cutAt).length - 1, 1, "the self-check's (ii) section marker must be unique");
  const head = body.slice(0, body.indexOf(cutAt));
  const dir = ownedFixtureDir(t, "w1t13177-selfcheck").dir;
  const script = join(dir, "self-check.sh");
  writeFileSync(script, mutateOnce(head, mutate));
  const r = spawnSync("bash", [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, STALE_AFTER_MINUTES: "30", DAEMON_EXPECTED_BRANCHES: "heartbeat-azure" },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("W1-T13177 criterion 3: the self-check exercises the restart arm before the live read, with a stubbed live 5 of 5 and an exited-134 5 of 5 response, and fails when the arm never raises or raises on ok", (t) => {
  const text = readFileSync(WORKFLOW, "utf8");
  assert.ok(text.indexOf(`- name: ${SELF_CHECK}`) < text.indexOf(`- name: ${JUDGE}`), "the self-check must run before the live read");
  // The two copies of the predicate are one decision: a drift between them is a regression the
  // self-check would no longer catch.
  assert.equal(stepBody(SELF_CHECK).split(PREDICATE).length - 1, 1, "the self-check must carry the restart predicate");
  assert.equal(stepBody(JUDGE).split(PREDICATE).length - 1, 1, "the judging step must carry the same restart predicate");

  const committed = runSelfCheckPredicates(t);
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.stdout, /self-check: restart arm raises a live 5 of 5 and an exited-134 5 of 5/);

  const never = runSelfCheckPredicates(t, [PREDICATE, NEVER_RAISES]);
  assert.notEqual(never.status, 0, "a restart arm that never raises must fail the self-check");
  assert.match(never.stderr, /SELF-CHECK FAILED: .*5 of 5/);

  const onOk = runSelfCheckPredicates(t, [PREDICATE, RAISES_ON_OK]);
  assert.notEqual(onOk.status, 0, "a restart arm that raises on ok must fail the self-check");
  assert.match(onOk.stderr, /SELF-CHECK FAILED: .*ok/);
});

// ── criterion 4 ───────────────────────────────────────────────────────────────────────────────

test("W1-T13177 criterion 4: a host another arm raises keeps its kind and still gets its restart record; ok, unlimited, unknown, skipped, operator_stopped and a missing line raise nothing; neither record's raise or resolve touches the other", (t) => {
  const masked = judge(t, {
    "heartbeat-sup": { payload: payloadOf("AT_LIMIT", { supervisor_verdict: "STALE — last deploy. line 2h ago" }) },
    "heartbeat-dmn": { payload: payloadOf("STOPPED_RETRY_EXHAUSTED", { daemon_verdict: "STALE — last poll 2h17m ago" }) },
  });
  assert.deepEqual(masked.liveness, { "heartbeat-sup": "SUPERVISOR_STALE", "heartbeat-dmn": "DAEMON_STALE" }, "the liveness kinds are unchanged");
  assert.deepEqual(masked.restart, { "heartbeat-sup": "SPENT", "heartbeat-dmn": "SPENT" }, "an earlier liveness arm must not mask the restart finding");
  const maskedOut = deliver(t, masked);
  assert.deepEqual(
    [...maskedOut.created].sort(),
    ["fleet-heartbeat:heartbeat-dmn", "fleet-heartbeat:heartbeat-dmn:restart", "fleet-heartbeat:heartbeat-sup", "fleet-heartbeat:heartbeat-sup:restart"],
    "each host gets its liveness record AND its restart record",
  );

  const quiet: Record<string, Host> = {
    "v-ok": { payload: payloadOf("ok") },
    "v-unlimited": { payload: payloadOf("unlimited") },
    "v-unknown": { payload: payloadOf("unknown") },
    "v-skipped": { payload: payloadOf("skipped") },
    "v-operator-stopped": { payload: payloadOf("operator_stopped") },
    "v-missing": { payload: payloadOf(null) },
    // A stale beat is not judged on a restart verdict it may no longer hold, and a host that runs
    // no daemon is not judged on one at all.
    "v-stale-beat": { payload: payloadOf("STOPPED_RETRY_EXHAUSTED"), age: 99_999 },
    "v-no-daemon": { payload: payloadOf("AT_LIMIT") },
  };
  const names = Object.keys(quiet);
  const quietRun = judge(t, quiet, { expected: names.filter((n) => n !== "v-no-daemon").join(" ") });
  assert.equal(Object.keys(quietRun.restart).length, names.length, `every host must get a restart line: ${JSON.stringify(quietRun.restart)}`);
  for (const n of names) {
    assert.equal(quietRun.restart[n], n === "v-ok" ? "OK" : "SILENT", `${n} must ${n === "v-ok" ? "resolve" : "neither raise nor resolve"}`);
  }
  assert.doesNotMatch(quietRun.stderr, /RESTART BUDGET SPENT/);
  assert.equal(quietRun.liveness["v-stale-beat"], "BEAT_STALE", "control: the stale host is still raised by its liveness arm");
  // The report says which quiet reading it was.
  assert.match(quietRun.bodies["v-unlimited"], /Restart budget: .*unlimited/);
  assert.match(quietRun.bodies["v-operator-stopped"], /Restart budget: .*operator_stopped/);
  assert.match(quietRun.bodies["v-missing"], /Restart budget: .*absent/);

  // Every host has an open restart record: only `ok` closes its own, nothing else touches one.
  const openRestart = names.map((n, i) => ({ number: 100 + i, source: `fleet-heartbeat:${n}:restart` }));
  const quietOut = deliver(t, quietRun, openRestart);
  assert.deepEqual(acted(quietOut, "close"), [100], "only the ok host's restart record is resolved");
  assert.deepEqual(acted(quietOut, "comment").filter((n) => n !== 100), [], "no quiet reading appends to a restart record");
  assert.ok(!quietOut.created.some((s) => s.endsWith(":restart")), `no quiet reading raises a restart record: ${quietOut.created}`);

  // INVARIANT the-restart-finding-stands-beside-liveness: two sources per host.
  const pair = judge(t, {
    "heartbeat-x": { payload: payloadOf("AT_LIMIT") },
    "heartbeat-y": { payload: payloadOf("ok", { daemon_verdict: "STALE — last poll 2h17m ago" }) },
  });
  const pairOut = deliver(t, pair, [
    { number: 1, source: "fleet-heartbeat:heartbeat-x" },
    { number: 2, source: "fleet-heartbeat:heartbeat-x:restart" },
    { number: 3, source: "fleet-heartbeat:heartbeat-y" },
    { number: 4, source: "fleet-heartbeat:heartbeat-y:restart" },
  ]);
  assert.deepEqual(acted(pairOut, "close").sort(), [1, 4], "x's liveness resolves and y's restart resolves, each alone");
  assert.deepEqual(acted(pairOut, "comment").filter((n) => n === 2 || n === 3).sort(), [2, 3], "x's restart and y's liveness are each still raised");
  assert.deepEqual(pairOut.created, [], "both raises append to their open records");
});

test("W1-T13177: the judging step writes its restart ledger beside its liveness ledger", (t) => {
  const run = judge(t, { "heartbeat-a": { payload: payloadOf("ok") } });
  // POSITIVE CONTROL on the file names this suite reads: a renamed output would otherwise leave
  // the assertions above comparing empty maps.
  const files = readdirSync(run.work).sort();
  assert.ok(files.includes("heartbeat-state.tsv"), `the judging step wrote no liveness ledger: ${files}`);
  assert.ok(files.includes("heartbeat-restart.tsv"), `the judging step wrote no restart ledger: ${files}`);
});
