import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectedRegistryShadowMain } from "#src/selected-registry-shadow-main.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-shell-shadow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "selected-private.yaml");
  const session = join(root, "session.json");
  const text = "instances:\n  core:\n    github_repo: craigoley/remudero\n    mode: shadow\n";
  writeFileSync(registry, text, { mode: 0o600 });
  const rows = () => readFileSync(session + ".observations", "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
  return { root, registry, session, text, rows };
}

async function capture(session: string, envPath?: string): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    assert.equal(await selectedRegistryShadowMain(["--shadow", "--capture", "--session", session],
      envPath === undefined ? {} : { RMD_INSTANCE_REGISTRY: envPath }), 0);
  } finally { console.log = original; }
  assert.match(lines[0] ?? "", /^[a-f0-9]{64}$/);
  return lines[0]!;
}

async function observe(session: string, pin: string, consumer: string, instance = "core") {
  return selectedRegistryShadowMain(["--shadow", "--session", session, "--pin", pin,
    "--consumer", consumer, "--instance", instance, "--repository", "craigoley/remudero", "--namespace", "host"]);
}

function refreshFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const names = ["core", "site", "console"];
  const legacyRegistry = join(f.root, "legacy.yaml");
  const lines = ["instances:"];
  for (const name of names) {
    const stateRoot = join(f.root, name);
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    writeFileSync(join(stateRoot, "state", "ledger.ndjson"), "");
    lines.push(`  ${name}:`, `    github_repo: craigoley/remudero${name === "core" ? "" : `-${name}`}`,
      "    mode: shadow", `    state_dir: ${stateRoot}`);
  }
  writeFileSync(legacyRegistry, lines.join("\n") + "\n");
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const calls = join(f.root, "docker.calls");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
  'inspect remudero-daemon --format '* ) printf '%s\\n' sha256:fixture ;;
  *'printenv GH_APP_ID'*) printf '%s\\n' fixture-app ;;
  *'printenv GH_APP_INSTALLATION_ID'*) printf '%s\\n' fixture-installation ;;
  *'printenv GH_APP_PRIVATE_KEY_PATH'*) printf '%s\\n' /fixture-key ;;
esac
`, { mode: 0o700 });
  chmodSync(join(bin, "docker"), 0o700);
  const cases = join(f.root, "cases.json"); writeFileSync(cases, "{}\n");
  const env = { ...process.env, HOME: f.root, PATH: `${bin}:${process.env.PATH ?? ""}`,
    DOCKER_CALLS: calls, RMD_INSTANCE_REGISTRY: legacyRegistry, RMD_FIELD_TRIALS_CASE_FILES: cases };
  const run = (args: string[] = []) => {
    writeFileSync(calls, "");
    const result = spawnSync("bash", [join(REPO_ROOT, "deploy", "field-trials-refresh.sh"), ...args],
      { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n") };
  };
  return { ...f, legacyRegistry, run };
}

test("selected shell shadow reaches real lifecycle and heartbeat consumers", async t => {
  const f = refreshFixture(t);
  const actual = f.run(["--selected-registry-shadow", f.session]);
  assert.equal(actual.status, 0, actual.stderr);
  assert.ok(actual.calls.some(call => call.startsWith("run ")), "real refresh launched recording Docker");
  assert.ok(actual.calls.every(call => !call.includes(f.session)), "the private session never enters Docker argv");
  assert.ok(f.rows().some(row => row.action === "field-trials"));
  const pin = createHash("sha256").update(readFileSync(f.session)).digest("hex");
  assert.equal(await observe(f.session, pin, "heartbeat"), 0);
  assert.equal(f.rows().at(-1)?.action, "heartbeat");
});

test("selected shell revisions invalidate generated child and heartbeat observations", async t => {
  const f = fixture(t);
  const pin = await capture(f.session, f.registry);
  assert.equal(await observe(f.session, pin, "launcher"), 0);
  assert.equal(f.rows().at(-1)?.selected_state, "ready");
  writeFileSync(f.registry, f.text.replace("mode: shadow", "mode: live"));
  assert.equal(await observe(f.session, pin, "heartbeat"), 0);
  const changed = f.rows().at(-1)!;
  assert.equal(changed.selected_outcome, "would-refuse");
  assert.equal(changed.selected_state, "unknown");
  assert.ok(["digest_mismatch", "revision_changed"].includes(String(changed.reason)));
});

test("selected shell qualification preserves mixed version legacy effects", t => {
  const f = refreshFixture(t);
  const before = f.run();
  const after = f.run(["--selected-registry-shadow", f.session]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, before.status);
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual(after.calls, before.calls, "qualification cannot change Docker arguments or effects");
  assert.ok(f.rows().length > 0);
});

test("selected shell qualification does not disclose private inputs", async t => {
  const f = fixture(t);
  const pin = await capture(f.session, f.registry);
  assert.equal(await observe(f.session, pin, "heartbeat"), 0);
  const publicRow = JSON.stringify(f.rows().at(-1));
  assert.doesNotMatch(publicRow, /selected-private\.yaml|session\.json|private-material-sentinel/);
  assert.equal(f.rows().at(-1)?.publication_permission, "not-granted");
  assert.equal(f.rows().at(-1)?.binding_digest, createHash("sha256").update(f.text).digest("hex"));
});

test("selected shell defaults and failures remain shadow only without live effects", async t => {
  const absent = fixture(t);
  const absentPin = await capture(absent.session);
  assert.equal(await observe(absent.session, absentPin, "install"), 0);
  assert.equal(absent.rows().at(-1)?.selected_state, "absent");
  const invalid = fixture(t);
  const invalidPin = await capture(invalid.session, "relative-invalid-path");
  assert.equal(await observe(invalid.session, invalidPin, "install"), 0);
  assert.equal(invalid.rows().at(-1)?.selected_state, "unknown");
  const sink = fixture(t);
  const sinkPin = await capture(sink.session, sink.registry);
  symlinkSync(join(sink.root, "elsewhere"), sink.session + ".observations");
  const errors: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try { assert.equal(await observe(sink.session, sinkPin, "install"), 1); }
  finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!, /selected-private\.yaml|session\.json|relative-invalid-path/);
});
