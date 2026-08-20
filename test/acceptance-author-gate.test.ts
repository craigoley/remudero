// test/acceptance-author-gate.test.ts
//
// W1-T1060 — THE AUTHOR-TIME ACCEPTANCE CHECK EXISTS AND CANNOT REACH THE PATHS THAT KEEP
// FAILING. `acceptanceAuthorTimeCheck` (src/lib/review.ts, W1-T952) already encodes the
// no-header/no-trailer/unparseable/empty-proofs predicate — this suite proves
// scripts/acceptance-author-gate.mjs is a thin, honest CALLER onto it (never a second
// implementation), reachable off a raw `pull_request` event payload with no API call, plus the
// ONE thing that predicate does not itself know: a `dependabot[bot]`-authored PR is exempt.
//
// WHAT IS REAL HERE: `evaluateGate`/`readEventPayload` are the production functions from the
// script itself, imported directly — no seam, nothing mocked. The CLI-level tests drive the real
// script as a subprocess (`node --import tsx scripts/acceptance-author-gate.mjs`, the same tsx
// binding `npm run cli-reference`/`api-client:generate` use for a `.mjs` file that imports a `.ts`
// module — see test/cli-reference.test.ts's own comment for this convention).

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/acceptance-author-gate.mjs"` is a TS7016 — the same reason
// test/clock-sweep.test.ts/test/mutation-ratchet.test.ts reach their scripts through a runtime
// import rather than a typed one. A dynamic specifier is not statically resolved, so this loads
// the REAL module with no shadow copy to drift from it.
const GATE_URL = pathToFileURL(SCRIPT).href;
const mod = (await import(GATE_URL)) as {
  EXEMPT_BOT_LOGINS: ReadonlySet<string>;
  readEventPayload: (eventPath: string) => { readable: boolean; body?: string; authorLogin?: string; reason?: string };
  evaluateGate: (input: { body: string; authorLogin?: string }) => { ok: boolean; defect?: string; message: string };
  resolveEventPath: (
    flagValue: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { ok: boolean; eventPath?: string; message?: string };
};
const { EXEMPT_BOT_LOGINS, evaluateGate, readEventPayload, resolveEventPath } = mod;

/** Byte-identical in shape to test/acceptance-block-diagnostics.test.ts's own WRAPPED fixture —
 *  a claim long enough that an author wrapped it onto a second line. `parseAcceptanceBlock`
 *  treats the wrap as the end of the block: written 3, parsed 1, empty proof. */
const WRAPPED_BODY = `## Acceptance

- claim: a claim long enough that an author wrapped it onto
  a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

/** The #277/#280 manual plan/doc shape `parseAcceptanceBlock`'s own doc names as legitimate: a
 *  `- claim:` bullet followed by an INDENTED `proof:` continuation line, never wrapped. */
const INDENTED_PROOF_BODY = `## Acceptance

- claim: the first criterion, written on one line
  proof: unit test: test/foo.test.ts
- claim: the second criterion, also one line
  proof: unit test: test/bar.test.ts
`;

function tmpEventFile(json: unknown): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-acceptance-gate-"));
  const path = join(dir, "event.json");
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json));
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runGate(eventPath: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--event-path", eventPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// ── The six task acceptance criteria, each its own named `unit test:` proof ────────────────────

test("acceptance gate: a block truncated at a wrapped claim is refused", () => {
  const result = evaluateGate({ body: WRAPPED_BODY, authorLogin: "a-human" });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unparseable");

  // And the same shape refuses end-to-end through the real event payload + CLI, never a silent
  // pass because it came from a file instead of a direct call.
  const event = tmpEventFile({ pull_request: { body: WRAPPED_BODY, user: { login: "a-human" } } });
  try {
    const run = runGate(event.path);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /REFUSED \(unparseable\)/);
  } finally {
    event.cleanup();
  }
});

test("acceptance gate: a trailered body is never refused", () => {
  // No Acceptance header at all — the only thing making this judgeable is the trailer, the same
  // "criteria resolve from plan/tasks.yaml" arm acceptanceAuthorTimeCheck itself reports.
  const body = "just prose, no header here\n\nRemudero-Task: W1-T1060\n";
  const result = evaluateGate({ body, authorLogin: "a-human" });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /criteria resolve from plan\/tasks\.yaml/);
});

test("acceptance gate: an indented proof continuation is not refused", () => {
  const result = evaluateGate({ body: INDENTED_PROOF_BODY, authorLogin: "a-human" });
  assert.equal(result.ok, true, result.ok ? "" : `${result.defect}: ${result.message}`);
  assert.equal(result.defect, undefined);
});

test("acceptance gate: a bot authored pull request is exempt", () => {
  assert.ok(EXEMPT_BOT_LOGINS.has("dependabot[bot]"), "dependabot[bot] must be in the exempt set");

  // A body that would otherwise fail outright (no header, no trailer, no bullets — the real shape
  // of an automated dependency-bump PR) is still exempt when the author is dependabot[bot].
  const wouldOtherwiseFail = evaluateGate({ body: "", authorLogin: "dependabot[bot]" });
  assert.equal(wouldOtherwiseFail.ok, true);
  assert.match(wouldOtherwiseFail.message, /dependabot\[bot\]/);
  assert.match(wouldOtherwiseFail.message, /exempt/);

  // The SAME empty body from a human author is correctly refused — proves the exemption is keyed
  // on the author, not a silent "empty body is fine" carve-out.
  const humanControl = evaluateGate({ body: "", authorLogin: "a-human" });
  assert.equal(humanControl.ok, false);
  assert.equal(humanControl.defect, "no-header");

  // End-to-end through the CLI too.
  const event = tmpEventFile({ pull_request: { body: "", user: { login: "dependabot[bot]" } } });
  try {
    const run = runGate(event.path);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /OK/);
  } finally {
    event.cleanup();
  }
});

test("acceptance gate: an unreadable body refuses instead of passing", () => {
  // A missing file.
  const missing = readEventPayload(join(tmpdir(), "rmd-acceptance-gate-no-such-file-xyzzy.json"));
  assert.equal(missing.readable, false);

  const dir = mkdtempSync(join(tmpdir(), "rmd-acceptance-gate-unreadable-"));
  try {
    // Malformed JSON.
    const badJsonPath = join(dir, "bad.json");
    writeFileSync(badJsonPath, "{ not valid json");
    const badJson = readEventPayload(badJsonPath);
    assert.equal(badJson.readable, false);

    // Valid JSON, but not a pull_request event at all (e.g. a push payload) — no
    // `pull_request` object to read a body or author from.
    const notPrPath = join(dir, "push.json");
    writeFileSync(notPrPath, JSON.stringify({ ref: "refs/heads/main" }));
    const notPr = readEventPayload(notPrPath);
    assert.equal(notPr.readable, false);

    // `pull_request.body` present but the wrong shape entirely (never string/null).
    const wrongShapePath = join(dir, "wrong-shape.json");
    writeFileSync(wrongShapePath, JSON.stringify({ pull_request: { body: 12345, user: { login: "a-human" } } }));
    const wrongShape = readEventPayload(wrongShapePath);
    assert.equal(wrongShape.readable, false);

    // Every one of these REFUSES through the real CLI too — exit 1, never a silent pass because
    // the input could not be read.
    for (const p of [badJsonPath, notPrPath, wrongShapePath]) {
      const run = runGate(p);
      assert.equal(run.status, 1, `${p}: ${run.stdout + run.stderr}`);
      assert.match(run.stderr, /REFUSED — unreadable event payload/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance gate: the refusal names the truncating bullet", () => {
  const result = evaluateGate({ body: WRAPPED_BODY, authorLogin: "a-human" });
  assert.equal(result.ok, false);
  assert.match(result.message, /bullet 2/, "the message names WHICH bullet the block ends before");
  assert.match(result.message, /3 bullet\(s\) written but only 1 parsed/, "and how many were written vs. parsed");
});

// ── Supporting coverage beyond the six named proofs (not itself a required proof) ───────────────

test("acceptance gate: a healthy pipe-form body (the orchestrator's own render shape) passes end-to-end", () => {
  const body = "Acceptance:\n- the claim | unit test: test/foo.test.ts\n- another claim | unit test: test/bar.test.ts\n";
  const event = tmpEventFile({ pull_request: { body, user: { login: "a-human" } } });
  try {
    const run = runGate(event.path);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    event.cleanup();
  }
});

test("acceptance gate: readEventPayload extracts the author login alongside the body", () => {
  const event = tmpEventFile({ pull_request: { body: "hello", user: { login: "octocat" } } });
  try {
    const payload = readEventPayload(event.path);
    assert.equal(payload.readable, true);
    assert.equal(payload.body, "hello");
    assert.equal(payload.authorLogin, "octocat");
  } finally {
    event.cleanup();
  }
});

test("acceptance gate: a null pull_request.body (GitHub's shape for an empty description) is readable, not unreadable", () => {
  const event = tmpEventFile({ pull_request: { body: null, user: { login: "a-human" } } });
  try {
    const payload = readEventPayload(event.path);
    assert.equal(payload.readable, true, "a null body is a legitimate empty description, not a corrupt payload");
    assert.equal(payload.body, "");
    // ...and it still fails the gate on its own merits (no header) — an unreadable INPUT and a
    // legitimately-empty-but-defective BODY are different things, and only the former refuses at
    // the readEventPayload layer.
    const result = evaluateGate({ body: payload.body, authorLogin: payload.authorLogin });
    assert.equal(result.ok, false);
    assert.equal(result.defect, "no-header");
  } finally {
    event.cleanup();
  }
});

test("acceptance gate: the workflow wires opened/synchronize/reopened/edited so a body correction re-runs without a new head", () => {
  // W1-T1060 rationale (4): ci.yml's own `on: pull_request` declares no `types:` override, so it
  // takes GitHub's default (opened/synchronize/reopened) -- which EXCLUDES `edited`. A gate on
  // those defaults would refuse a body, the author would fix the body, and NOTHING would re-run.
  // `types:` is a WORKFLOW-level filter, not a per-job one, so this gate lives in its OWN workflow
  // file (leaving ci.yml, and the full CI cycle it triggers, untouched by a mere body edit) with
  // its own explicit `types:` list that includes `edited`.
  const workflowPath = join(REPO_ROOT, ".github", "workflows", "acceptance-author-gate.yml");
  const text = readFileSync(workflowPath, "utf8");
  assert.match(text, /pull_request:\s*\n\s*types:\s*\[opened,\s*synchronize,\s*reopened,\s*edited\]/);
  assert.match(text, /acceptance-author-gate\.mjs/);
});

// ── the refusal arm diff-coverage named ───────────────────────────────────────────────────────

test("W1-T1060: with no --event-path and no GITHUB_EVENT_PATH the gate REFUSES rather than guessing", () => {
  // Inline in `main` this arm ran only when the script was invoked as a process, so nothing covered
  // it. Extracted, both directions are reachable without spawning anything.
  const refused = resolveEventPath(undefined, {});
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /REFUSED/);
  assert.match(refused.message!, /--event-path/, "the refusal names the flag that would fix it");
  assert.match(refused.message!, /GITHUB_EVENT_PATH/, "and the environment variable too");

  // POSITIVE CONTROL 1 — the flag alone resolves, so the refusal is the absence and not a
  // resolver that never succeeds.
  const viaFlag = resolveEventPath("/tmp/event.json", {});
  assert.equal(viaFlag.ok, true);
  assert.equal(viaFlag.eventPath, "/tmp/event.json");

  // POSITIVE CONTROL 2 — the environment alone resolves too.
  const viaEnv = resolveEventPath(undefined, { GITHUB_EVENT_PATH: "/tmp/from-env.json" });
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.eventPath, "/tmp/from-env.json");

  // and the flag WINS over the environment, which is the documented precedence
  const both = resolveEventPath("/tmp/flag.json", { GITHUB_EVENT_PATH: "/tmp/env.json" });
  assert.equal(both.eventPath, "/tmp/flag.json");
});
