// test/openweight-probe.test.ts — W1-T3576: a replayable openweight probe keeps its raw evidence.
//
// Every test drives scripts/openweight-probe.mjs through an injected, deterministic local
// transport. No test makes a network call, and the only "key" anywhere in this file is the obvious
// fixture FAKE_KEY below; the process environment is never consulted for a real one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — this executable .mjs intentionally has no declaration output; the seam this
// suite consumes is typed immediately below rather than left as any.
import * as probeModule from "../scripts/openweight-probe.mjs";
import { OPENWEIGHT_OUTPUT_CONTRACT } from "../src/lib/worker-provider.js";

interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
interface TransportReply {
  status: number;
  text: string;
}
interface ProbeDeps {
  env?: Record<string, string | undefined>;
  cwd?: string;
  repoRoot?: string;
  transport?: (request: TransportRequest) => Promise<TransportReply>;
  runKeyCommand?: (command: string, args: string[]) => { status: number | null; stdout: string; failed?: boolean };
  insideGitWorkTree?: (dir: string) => boolean;
  readFile?: (path: string) => string;
  now?: () => Date;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}
interface ProbeResult {
  exitCode: number;
  refusal?: { code: string; message: string };
  sessionDir?: string;
  summary?: { requested: number; pass: number; fail: number; error: number };
}

const probe = probeModule as {
  runProbe(argv: string[], deps?: ProbeDeps): Promise<ProbeResult>;
  main(argv: string[], deps?: ProbeDeps): Promise<number>;
  validateRunRecord(record: unknown): string[];
  redactSecrets(text: string, secrets: string[]): string;
  azureKeyCommand(account: string, group: string): { command: string; args: string[] };
  findCliCredential(argv: string[]): string | null;
  REDACTED: string;
  MAX_PROBE_RUNS: number;
  COMPLETION_TOKEN_FLOOR: number;
  CLI_CREDENTIAL_FLAG_RE: RegExp;
  SESSION_NAME_RE: RegExp;
  LABEL_RE: RegExp;
  MODEL_ID_RE: RegExp;
  AZURE_NAME_RE: RegExp;
};

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_KEY = "rmd-fixture-fake-openweight-key-7f3a9c";
const ENDPOINT = "https://probe-fixture.example.invalid/";
const EXPECTED_URL =
  "https://probe-fixture.example.invalid/openai/deployments/gpt-oss-120b/chat/completions?api-version=2024-10-21";
const AUTHORING_PROMPT = "Draft one task shard for the fixture. Emit the raw YAML document only.\n";

function scratch(): { root: string; outDir: string; promptFile: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-probe-"));
  const outDir = join(root, "evidence");
  const promptFile = join(root, "prompt.txt");
  writeFileSync(promptFile, AUTHORING_PROMPT);
  return { root, outDir, promptFile };
}

function recordingTransport(replies: Array<TransportReply | Error>) {
  const calls: TransportRequest[] = [];
  const transport = async (request: TransportRequest): Promise<TransportReply> => {
    calls.push(request);
    const next = replies[calls.length - 1];
    if (next instanceof Error) throw next;
    assert.ok(next, "the fixture transport was called more times than it has replies");
    return next;
  };
  return { calls, transport };
}

function chatReply(content: string, finishReason = "stop"): TransportReply {
  return {
    status: 200,
    text: JSON.stringify({
      id: "chatcmpl-fixture",
      choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 120, completion_tokens: 480 },
    }),
  };
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 28, 12, 0, tick++));
}

function baseDeps(overrides: ProbeDeps = {}): ProbeDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    env: { RMD_OPENWEIGHT_API_KEY: FAKE_KEY },
    cwd: REPO_ROOT,
    insideGitWorkTree: () => false,
    now: fixedClock(),
    log: (line: string) => logs.push(line),
    ...overrides,
    logs,
  };
}

function readSession(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) files.set(name, readFileSync(join(dir, name), "utf8"));
  return files;
}

const VALID_SHARD = [
  "- id: W1-T9999",
  '  title: "A FIXTURE SHARD"',
  "  acceptance:",
  '    - claim: "the fixture parses"',
  '      proof: "unit test: the fixture parses"',
].join("\n");
const UNQUOTED_PROOF_SHARD = [
  "- id: W1-T9999",
  "  title: A FIXTURE SHARD",
  "  acceptance:",
  "    - claim: the fixture parses",
  "      proof: unit test: the fixture parses",
].join("\n");

test("openweight probe retains raw evidence without credentials", async () => {
  const { outDir, promptFile } = scratch();
  const replies = [chatReply("```yaml\n" + VALID_SHARD + "\n```"), chatReply(UNQUOTED_PROOF_SHARD)];
  const { calls, transport } = recordingTransport(replies);
  const deps = baseDeps({ transport });
  const result = await probe.runProbe(
    ["--mode", "authoring", "--prompt-file", promptFile, "--out-dir", outDir, "--endpoint", ENDPOINT, "--runs", "2", "--name", "quote-rule-a"],
    deps,
  );
  assert.equal(result.refusal, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionDir, join(outDir, "quote-rule-a"), "evidence lands in the caller-selected directory");

  // The request the transport saw is the lane shape: contract first, temperature 0, >= 5000 budget.
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, EXPECTED_URL);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["api-key"], FAKE_KEY, "the resolved key authenticates the request");
    const body = JSON.parse(call.body);
    assert.equal(body.model, "gpt-oss-120b");
    assert.equal(body.temperature, 0);
    assert.ok(body.max_completion_tokens >= 5000);
    assert.equal("response_format" in body, false);
    assert.deepEqual(body.messages, [
      { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT },
      { role: "user", content: AUTHORING_PROMPT },
    ]);
  }

  const files = readSession(result.sessionDir as string);
  assert.deepEqual([...files.keys()], [".gitignore", "run-001.json", "run-002.json", "session.json", "summary.json"]);
  assert.equal(files.get(".gitignore"), "*\n", "the session directory ignores itself");
  for (const [name, text] of files) {
    assert.equal(text.includes(FAKE_KEY), false, `${name} must never serialize the key`);
  }
  for (const line of deps.logs) assert.equal(line.includes(FAKE_KEY), false, "no log line may carry the key");

  const runs = [1, 2].map((index) => JSON.parse(files.get(`run-00${index}.json`) as string));
  runs.forEach((record, i) => {
    assert.deepEqual(probe.validateRunRecord(record), [], `run ${i + 1} is schema-valid`);
    assert.equal(record.prompt.user, AUTHORING_PROMPT);
    assert.equal(record.prompt.system, OPENWEIGHT_OUTPUT_CONTRACT);
    assert.equal(record.response.raw, replies[i].text, "the raw HTTP body is retained verbatim");
    assert.equal(record.model, "gpt-oss-120b");
    assert.deepEqual(record.endpoint, {
      host: "probe-fixture.example.invalid",
      url: EXPECTED_URL,
      deployment: "gpt-oss-120b",
      apiVersion: "2024-10-21",
    });
    assert.equal(record.request.headers["api-key"], probe.REDACTED);
    assert.equal(record.request.body.temperature, 0);
    assert.match(record.timestamps.startedAt, /^2026-09-28T12:00:\d\d\.000Z$/);
    assert.match(record.timestamps.completedAt, /^2026-09-28T12:00:\d\d\.000Z$/);
  });

  // Run 1: fenced but valid — parsed and passing. Run 2: the unquoted colon fails to parse, and the
  // retained raw content is what lets that be attributed to the prompt contract, not the model.
  assert.equal(runs[0].response.content, "```yaml\n" + VALID_SHARD + "\n```");
  assert.equal(runs[0].parsed.fenced, true);
  assert.equal(runs[0].parsed.document[0].acceptance[0].proof, "unit test: the fixture parses");
  assert.deepEqual(runs[0].validation, { verdict: "pass", reasons: [] });
  assert.equal(runs[1].response.content, UNQUOTED_PROOF_SHARD);
  assert.equal(runs[1].parsed.document, null);
  assert.equal(runs[1].validation.verdict, "fail");
  assert.match(runs[1].validation.reasons[0], /^yaml-parse-failed: /);

  const session = JSON.parse(files.get("session.json") as string);
  assert.equal(session.keySource, "env");
  assert.equal(session.prompt.user, AUTHORING_PROMPT);
  const summary = JSON.parse(files.get("summary.json") as string);
  assert.equal(summary.requested, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.error, 0);
});

test("openweight probe retains a classification verdict against its closed labels", async () => {
  const { root, outDir } = scratch();
  const promptFile = join(root, "classify.txt");
  writeFileSync(promptFile, "Classify the fixture. Reply with exactly one of: accept, reject, defer.\n");
  const { calls, transport } = recordingTransport([chatReply("reject"), chatReply("unknown"), chatReply("defer", "length")]);
  const result = await probe.runProbe(
    ["--mode", "classification", "--labels", "accept,reject,defer", "--prompt-file", promptFile, "--out-dir", outDir, "--endpoint", ENDPOINT, "--runs", "3"],
    baseDeps({ transport }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 3);
  const sessionDir = result.sessionDir as string;
  assert.match(sessionDir, /openweight-classification-gpt-oss-120b-2026-09-28T12-00-00-000Z$/, "a derived session name when none is given");
  const records = ["run-001.json", "run-002.json", "run-003.json"].map((name) => JSON.parse(readFileSync(join(sessionDir, name), "utf8")));
  for (const record of records) assert.deepEqual(probe.validateRunRecord(record), []);
  assert.deepEqual(records.map((record) => record.parsed.label), ["reject", "unknown", "defer"]);
  assert.deepEqual(records.map((record) => record.validation.verdict), ["pass", "fail", "fail"]);
  assert.deepEqual(records[0].labels, ["accept", "reject", "defer"]);
  assert.equal(records[2].validation.reasons[0], "truncated (finish_reason=length)", "a truncated reply is never a pass");
  assert.equal(typeof records[0].response.usd, "number");
});

test("openweight probe redacts a credential echoed by a failing transport and stops", async () => {
  const { outDir, promptFile } = scratch();
  const failing = recordingTransport([new Error(`socket reset while sending api-key: ${FAKE_KEY}`)]);
  const deps = baseDeps({ transport: failing.transport });
  const thrown = await probe.runProbe(
    ["--mode", "authoring", "--prompt-file", promptFile, "--out-dir", outDir, "--endpoint", ENDPOINT, "--runs", "3", "--name", "thrown"],
    deps,
  );
  assert.equal(thrown.exitCode, 1, "a transport error stops the session");
  assert.equal(failing.calls.length, 1, "no further paid request after a transport error");
  const record = JSON.parse(readFileSync(join(outDir, "thrown", "run-001.json"), "utf8"));
  assert.deepEqual(probe.validateRunRecord(record), []);
  assert.equal(record.validation.verdict, "error");
  assert.equal(record.error, `socket reset while sending api-key: ${probe.REDACTED}`);

  const echoing = recordingTransport([{ status: 401, text: JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }) }]);
  const refusedByServer = await probe.runProbe(
    ["--mode", "authoring", "--prompt-file", promptFile, "--out-dir", outDir, "--endpoint", ENDPOINT, "--name", "http-401"],
    baseDeps({ transport: echoing.transport }),
  );
  assert.equal(refusedByServer.exitCode, 1);
  const httpRecord = JSON.parse(readFileSync(join(outDir, "http-401", "run-001.json"), "utf8"));
  assert.equal(httpRecord.error, "HTTP 401");
  assert.equal(httpRecord.response.raw, JSON.stringify({ error: { message: `bad key ${probe.REDACTED}` } }));
  for (const session of ["thrown", "http-401"]) {
    for (const [name, text] of readSession(join(outDir, session))) {
      assert.equal(text.includes(FAKE_KEY), false, `${session}/${name} must never serialize the key`);
    }
  }
  for (const line of deps.logs) assert.equal(line.includes(FAKE_KEY), false);
});

test("openweight probe resolves its key from the named azure command without persisting it", async () => {
  const { outDir, promptFile } = scratch();
  const keyCalls: Array<{ command: string; args: string[] }> = [];
  const { calls, transport } = recordingTransport([chatReply(VALID_SHARD)]);
  const result = await probe.runProbe(
    [
      "--mode", "authoring", "--prompt-file", promptFile, "--out-dir", outDir, "--endpoint", ENDPOINT,
      "--key-source", "azure-cli", "--azure-account", "synthwatch-foundry", "--azure-resource-group", "rg-fixture",
    ],
    baseDeps({
      env: {},
      transport,
      runKeyCommand: (command, args) => {
        keyCalls.push({ command, args });
        return { status: 0, stdout: `${FAKE_KEY}\n` };
      },
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(keyCalls, [probe.azureKeyCommand("synthwatch-foundry", "rg-fixture")]);
  assert.deepEqual(probe.azureKeyCommand("acct", "rg"), {
    command: "az",
    args: ["cognitiveservices", "account", "keys", "list", "--name", "acct", "--resource-group", "rg", "--query", "key1", "--output", "tsv"],
  });
  assert.equal(calls[0].headers["api-key"], FAKE_KEY);
  const files = readSession(result.sessionDir as string);
  assert.equal(JSON.parse(files.get("session.json") as string).keySource, "azure-cli");
  for (const [name, text] of files) assert.equal(text.includes(FAKE_KEY), false, `${name} must never serialize the key`);
});

interface RefusalCase {
  name: string;
  argv: (paths: { root: string; outDir: string; promptFile: string }) => string[];
  deps?: (paths: { root: string; outDir: string }) => ProbeDeps;
  code: string;
  keyCommandCalls?: number;
}

const common = (p: { outDir: string; promptFile: string }) => ["--prompt-file", p.promptFile, "--out-dir", p.outDir, "--endpoint", ENDPOINT];

const REFUSALS: RefusalCase[] = [
  { name: "absent env key", argv: (p) => ["--mode", "authoring", ...common(p)], deps: () => ({ env: {} }), code: "no-credential" },
  { name: "blank env key", argv: (p) => ["--mode", "authoring", ...common(p)], deps: () => ({ env: { RMD_OPENWEIGHT_API_KEY: "  \n" } }), code: "no-credential" },
  {
    name: "failing azure command",
    argv: (p) => ["--mode", "authoring", ...common(p), "--key-source", "azure-cli", "--azure-account", "acct", "--azure-resource-group", "rg"],
    deps: () => ({ env: {}, runKeyCommand: () => ({ status: 1, stdout: "" }) }),
    code: "no-credential",
    keyCommandCalls: 1,
  },
  {
    name: "azure command printing nothing",
    argv: (p) => ["--mode", "authoring", ...common(p), "--key-source", "azure-cli", "--azure-account", "acct", "--azure-resource-group", "rg"],
    deps: () => ({ env: {}, runKeyCommand: () => ({ status: 0, stdout: "\n" }) }),
    code: "no-credential",
    keyCommandCalls: 1,
  },
  {
    name: "azure source without its names",
    argv: (p) => ["--mode", "authoring", ...common(p), "--key-source", "azure-cli"],
    deps: () => ({ env: {}, runKeyCommand: () => ({ status: 0, stdout: FAKE_KEY }) }),
    code: "bad-argument",
    keyCommandCalls: 0,
  },
  { name: "unknown key source", argv: (p) => ["--mode", "authoring", ...common(p), "--key-source", "file"], code: "bad-key-source" },
  { name: "--api-key=value", argv: (p) => ["--mode", "authoring", ...common(p), `--api-key=${FAKE_KEY}`], code: "cli-credential" },
  { name: "--key value", argv: (p) => ["--key", FAKE_KEY, "--mode", "authoring", ...common(p)], code: "cli-credential" },
  { name: "--token value", argv: (p) => ["--mode", "authoring", ...common(p), "--token", FAKE_KEY], code: "cli-credential" },
  { name: "stray positional", argv: (p) => ["--mode", "authoring", ...common(p), FAKE_KEY], code: "bad-argument" },
  { name: "key smuggled through another flag", argv: (p) => ["--mode", "authoring", ...common(p), "--name", FAKE_KEY], code: "credential-in-argv" },
  { name: "no --out-dir", argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--endpoint", ENDPOINT], code: "no-output-path" },
  {
    name: "--out-dir inside this repository",
    argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", join(REPO_ROOT, "state", "openweight-probe-never"), "--endpoint", ENDPOINT],
    code: "output-in-repository",
  },
  {
    name: "--out-dir reaching the repository through a symlink",
    argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", join(p.root, "link", "evidence"), "--endpoint", ENDPOINT],
    deps: (p) => {
      const fakeRepo = join(p.root, "fake-repo");
      mkdirSync(fakeRepo);
      symlinkSync(fakeRepo, join(p.root, "link"));
      return { repoRoot: fakeRepo };
    },
    code: "output-in-repository",
  },
  {
    name: "--out-dir inside another git work tree",
    argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", join(p.root, "other-repo", "evidence"), "--endpoint", ENDPOINT],
    deps: (p) => {
      mkdirSync(join(p.root, "other-repo"));
      const init = spawnSync("git", ["init", "-q", join(p.root, "other-repo")], { encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      return { insideGitWorkTree: undefined };
    },
    code: "output-in-git-work-tree",
  },
  {
    name: "--out-dir naming a file",
    argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", p.promptFile, "--endpoint", ENDPOINT],
    code: "output-not-directory",
  },
  {
    name: "an existing session",
    argv: (p) => ["--mode", "authoring", ...common(p), "--name", "taken"],
    deps: (p) => {
      mkdirSync(join(p.outDir, "taken"), { recursive: true });
      return {};
    },
    code: "session-exists",
  },
  { name: "http endpoint", argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", p.outDir, "--endpoint", "http://probe-fixture.example.invalid/"], code: "bad-endpoint" },
  { name: "endpoint with query", argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", p.outDir, "--endpoint", `${ENDPOINT}?api-key=x`], code: "bad-endpoint" },
  { name: "endpoint missing", argv: (p) => ["--mode", "authoring", "--prompt-file", p.promptFile, "--out-dir", p.outDir], code: "bad-endpoint" },
  { name: "zero runs", argv: (p) => ["--mode", "authoring", ...common(p), "--runs", "0"], code: "bad-runs" },
  { name: "runs above the cap", argv: (p) => ["--mode", "authoring", ...common(p), "--runs", String(probe.MAX_PROBE_RUNS + 1)], code: "bad-runs" },
  { name: "a model refusing temperature 0", argv: (p) => ["--mode", "authoring", ...common(p), "--model", "gpt-5-nano"], code: "temperature-unsupported" },
  { name: "an unpriced model", argv: (p) => ["--mode", "authoring", ...common(p), "--model", "DeepSeek-V4-Flash"], code: "unpriced-model" },
  { name: "a priced but unshaped model", argv: (p) => ["--mode", "authoring", ...common(p), "--model", "claude-opus-5-5"], code: "unshaped-model" },
  { name: "an unsafe model id", argv: (p) => ["--mode", "authoring", ...common(p), "--model", "../x"], code: "bad-model" },
  { name: "classification without labels", argv: (p) => ["--mode", "classification", ...common(p)], code: "bad-labels" },
  { name: "authoring with labels", argv: (p) => ["--mode", "authoring", ...common(p), "--labels", "a,b"], code: "bad-labels" },
  { name: "no mode", argv: (p) => common(p), code: "bad-mode" },
  { name: "an unsafe session name", argv: (p) => ["--mode", "authoring", ...common(p), "--name", "../escape"], code: "bad-name" },
  { name: "a missing prompt file", argv: (p) => ["--mode", "authoring", "--prompt-file", join(p.outDir, "absent.txt"), "--out-dir", p.outDir, "--endpoint", ENDPOINT], code: "prompt-unreadable" },
  { name: "no prompt file", argv: (p) => ["--mode", "authoring", "--out-dir", p.outDir, "--endpoint", ENDPOINT], code: "prompt-unreadable" },
];

test("openweight probe refuses unsafe invocation before transport", async () => {
  for (const refusal of REFUSALS) {
    const paths = scratch();
    const { calls, transport } = recordingTransport([chatReply(VALID_SHARD)]);
    let keyCommandCalls = 0;
    const extra = refusal.deps?.(paths) ?? {};
    const deps = baseDeps({
      transport,
      runKeyCommand: () => {
        keyCommandCalls += 1;
        return { status: 0, stdout: FAKE_KEY };
      },
      ...extra,
    });
    if ("insideGitWorkTree" in extra && extra.insideGitWorkTree === undefined) delete deps.insideGitWorkTree;
    if (extra.runKeyCommand) {
      const inner = extra.runKeyCommand;
      deps.runKeyCommand = (command, args) => {
        keyCommandCalls += 1;
        return inner(command, args);
      };
    }
    const before = readdirSync(paths.root).sort();
    const result = await probe.runProbe(refusal.argv(paths), deps);
    assert.equal(result.exitCode, 2, `${refusal.name}: refused`);
    assert.equal(result.refusal?.code, refusal.code, `${refusal.name}: refusal code`);
    assert.equal(calls.length, 0, `${refusal.name}: the transport must never be called`);
    assert.equal(result.sessionDir, undefined, `${refusal.name}: no session is created`);
    assert.equal(result.refusal?.message.includes(FAKE_KEY), false, `${refusal.name}: the refusal never echoes the key`);
    for (const line of deps.logs) assert.equal(line.includes(FAKE_KEY), false);
    if (refusal.keyCommandCalls !== undefined) assert.equal(keyCommandCalls, refusal.keyCommandCalls, `${refusal.name}: key command calls`);
    if (refusal.code !== "session-exists") {
      assert.deepEqual(readdirSync(paths.root).sort(), before, `${refusal.name}: nothing written under the scratch root`);
    } else {
      assert.deepEqual(readdirSync(join(paths.outDir, "taken")), [], "an existing session is never written into");
    }
  }
});

test("openweight probe main prints a refusal without the argv value and exits 2", async () => {
  const errors: string[] = [];
  const code = await probe.main(["--mode", "authoring", `--api-key=${FAKE_KEY}`], { errorLog: (line) => errors.push(line), log: () => {} });
  assert.equal(code, 2);
  assert.deepEqual(errors, [
    "openweight-probe: REFUSED (cli-credential): --api-key refused: a key is read only from RMD_OPENWEIGHT_API_KEY or the Azure key-retrieval command",
  ]);
  const help: string[] = [];
  assert.equal(await probe.main(["--help"], { log: (line) => help.push(line) }), 0);
  assert.match(help[0], /--out-dir must sit outside every git work tree/);
});

test("openweight probe refuses a command-line key when run as a process", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "openweight-probe.mjs"), "--mode", "authoring", `--key=${FAKE_KEY}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /REFUSED \(cli-credential\): --key refused/);
  assert.equal(`${child.stdout}${child.stderr}`.includes(FAKE_KEY), false);
});

test("openweight probe patterns accept what they name and refuse the rest", () => {
  assert.equal(probe.CLI_CREDENTIAL_FLAG_RE.test("--api-key=abc"), true);
  assert.equal(probe.CLI_CREDENTIAL_FLAG_RE.test("--API_KEY"), true);
  assert.equal(probe.CLI_CREDENTIAL_FLAG_RE.test("--key-source"), false, "--key-source names a source, never a key");
  assert.equal(probe.CLI_CREDENTIAL_FLAG_RE.test("--mode"), false);
  assert.equal(probe.findCliCredential(["--mode", "x", "--secret=abc"]), "--secret");
  assert.equal(probe.findCliCredential(["--key-source", "env"]), null);
  assert.equal(probe.SESSION_NAME_RE.test("quote-rule-a.v2"), true);
  assert.equal(probe.SESSION_NAME_RE.test("../escape"), false);
  assert.equal(probe.LABEL_RE.test("accept"), true);
  assert.equal(probe.LABEL_RE.test("two words"), false);
  assert.equal(probe.MODEL_ID_RE.test("gpt-oss-120b"), true);
  assert.equal(probe.MODEL_ID_RE.test("gpt/oss"), false);
  assert.equal(probe.AZURE_NAME_RE.test("rg-synthwatch_eastus2"), true);
  assert.equal(probe.AZURE_NAME_RE.test("rg; rm -rf"), false);
  assert.equal(probe.redactSecrets(`a ${FAKE_KEY} b "${FAKE_KEY}"`, [FAKE_KEY]), `a ${probe.REDACTED} b "${probe.REDACTED}"`);
  assert.equal(probe.redactSecrets("untouched", ["", FAKE_KEY]), "untouched");
  assert.equal(probe.COMPLETION_TOKEN_FLOOR, 5000);
});

test("openweight probe schema refuses a record missing its raw output", () => {
  const record = {
    schema: "rmd.openweight-probe.run/v1",
    run: { index: 1, of: 1 },
    mode: "authoring",
    model: "gpt-oss-120b",
    endpoint: { host: "h", url: "https://h/", deployment: "gpt-oss-120b", apiVersion: "2024-10-21" },
    request: { headers: { "api-key": probe.REDACTED }, body: { temperature: 0, max_completion_tokens: 8000 } },
    prompt: { system: "s", user: "u", sha256: "x" },
    response: { raw: "{}", content: "c" },
    parsed: null,
    validation: { verdict: "pass", reasons: [] },
    error: null,
    timestamps: { startedAt: "t0", completedAt: "t1" },
  };
  assert.deepEqual(probe.validateRunRecord(record), []);
  assert.deepEqual(probe.validateRunRecord({ ...record, response: { content: "c" } }), ["response.raw"]);
  assert.deepEqual(probe.validateRunRecord({ ...record, request: { ...record.request, headers: { "api-key": FAKE_KEY } } }), [
    "request.headers api-key redacted",
  ]);
  assert.deepEqual(probe.validateRunRecord({ ...record, validation: { verdict: "error", reasons: [] }, response: null }), ["error"]);
});
