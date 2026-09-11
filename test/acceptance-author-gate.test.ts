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
type TaskFilesForId = (taskId: string) => readonly string[] | undefined;
type GateInput = {
  body: string;
  authorLogin?: string;
  trailerResolves?: (taskId: string) => boolean;
  introducedTaskIds?: string[];
  trailerCommits?: Array<{ sha: string; subject: string; taskId: string }>;
  changedPaths?: readonly string[];
  taskFilesForId?: TaskFilesForId;
};
type GateVerdict = { ok: boolean; defect?: string; message: string };
const mod = (await import(GATE_URL)) as {
  EXEMPT_BOT_LOGINS: ReadonlySet<string>;
  commitTaskTrailersAtRange: (input?: {
    baseSha?: string;
    headSha?: string;
    root?: string;
    git?: (args: string[]) => string;
  }) => Array<{ sha: string; subject: string; taskId: string }> | undefined;
  changedPathsAtRange: (input?: {
    baseSha?: string;
    headSha?: string;
    root?: string;
    git?: (args: string[]) => string;
  }) => string[] | undefined;
  planTaskFilesResolver: (root?: string) => TaskFilesForId | undefined;
  readEventPayload: (eventPath: string) => { readable: boolean; body?: string; authorLogin?: string; reason?: string };
  evaluateGate: (input: GateInput) => GateVerdict;
  main: (argv: string[]) => void;
  resolveEventPath: (
    flagValue: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { ok: boolean; eventPath?: string; message?: string };
};
const { EXEMPT_BOT_LOGINS, changedPathsAtRange, commitTaskTrailersAtRange, evaluateGate, main, planTaskFilesResolver, readEventPayload, resolveEventPath } = mod;

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

async function structuralPredicateMutant(): Promise<{ evaluateGate: (input: GateInput) => GateVerdict; cleanup: () => void }> {
  const source = readFileSync(SCRIPT, "utf8");
  const predicate =
    "  const structuralRefusal = planOnlyImplementationTrailerRefusal({ body, changedPaths, taskFilesForId });\n" +
    "  if (structuralRefusal !== undefined) return structuralRefusal;\n";
  assert.equal(source.split(predicate).length - 1, 1, "the W1-T3149 predicate must have exactly one source location");
  const imports = [
    ["./lib/argv.mjs", join(REPO_ROOT, "scripts", "lib", "argv.mjs")],
    ["../src/lib/review.ts", join(REPO_ROOT, "src", "lib", "review.ts")],
    ["../src/lib/plan.ts", join(REPO_ROOT, "src", "lib", "plan.ts")],
    ["../src/lib/plan-scope.ts", join(REPO_ROOT, "src", "lib", "plan-scope.ts")],
    ["./lib/repo-root.mjs", join(REPO_ROOT, "scripts", "lib", "repo-root.mjs")],
  ] as const;
  const rewrittenImports = imports.reduce(
    (text, [from, absolute]) => text.replace(`from "${from}"`, `from "${pathToFileURL(absolute).href}"`),
    source.replace(predicate, ""),
  );
  const dir = mkdtempSync(join(tmpdir(), "rmd-acceptance-gate-mutant-"));
  const path = join(dir, "acceptance-author-gate.mjs");
  writeFileSync(path, rewrittenImports);
  const mutant = (await import(pathToFileURL(path).href)) as { evaluateGate: (input: GateInput) => GateVerdict };
  return { evaluateGate: mutant.evaluateGate, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── The six task acceptance criteria, each its own named `unit test:` proof ────────────────────

const IMPLEMENTATION_TASK = "W1-T3101";
const IMPLEMENTATION_FILES = [
  "src/lib/skill-workshop.ts",
  "src/lib/prompt-render.ts",
  "src/run-task.ts",
  "test/a-staged-skill-reaches-the-worker-prompt.test.ts",
];
const IMPLEMENTATION_BODY = `This PR changes planning only.\n\nRemudero-Task: ${IMPLEMENTATION_TASK}\n`;
const implementationTaskFiles: TaskFilesForId = (taskId) => (taskId === IMPLEMENTATION_TASK ? IMPLEMENTATION_FILES : undefined);

test("W1-T3149 criterion 1: a plan-only diff trailered to an implementation task is refused with both remedies", () => {
  const calls: string[][] = [];
  const changedPaths = changedPathsAtRange({
    baseSha: "base",
    headSha: "head",
    git(args) {
      calls.push(args);
      return "plan/tasks.d/W1-T3149.yaml\0";
    },
  });
  assert.deepEqual(changedPaths, ["plan/tasks.d/W1-T3149.yaml"]);
  assert.deepEqual(calls, [["diff", "--name-only", "-z", "--no-renames", "base...head"]]);
  const taskFilesForId = planTaskFilesResolver();
  if (taskFilesForId === undefined) assert.fail("the checked-out plan must resolve W1-T3101's declared files");
  assert.deepEqual(taskFilesForId(IMPLEMENTATION_TASK), IMPLEMENTATION_FILES);

  const result = evaluateGate({
    body: IMPLEMENTATION_BODY,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
    changedPaths,
    taskFilesForId,
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "plan-only-implementation-trailer");
  assert.match(result.message, /Remudero-Task: W1-T3101/);
  for (const path of IMPLEMENTATION_FILES) assert.ok(result.message.includes(path), `refusal names ${path}`);
  assert.match(result.message, /Remove the trailer/);
  assert.match(result.message, /## Acceptance/);
  assert.match(result.message, /include the implementation changes/);
});

test("W1-T3149 criterion 2: a plan-only task keeps its trailer on a plan-only diff", () => {
  const planTask = "W1-TPLAN";
  const result = evaluateGate({
    body: `Remudero-Task: ${planTask}\n`,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === planTask,
    changedPaths: ["plan/tasks.d/W1-TPLAN.yaml"],
    taskFilesForId: (taskId) => (taskId === planTask ? ["plan/tasks.d/W1-TPLAN.yaml"] : undefined),
  });
  assert.equal(result.ok, true, result.message);
});

test("W1-T3149 criterion 3: an implementation-task trailer passes when its diff changes source", () => {
  const result = evaluateGate({
    body: IMPLEMENTATION_BODY,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
    changedPaths: ["plan/tasks.d/W1-T3149.yaml", "src/lib/skill-workshop.ts"],
    taskFilesForId: implementationTaskFiles,
  });
  assert.equal(result.ok, true, result.message);
});

test("W1-T3149 criterion 4: missing, empty, or unreadable local diff evidence preserves the existing verdict", () => {
  const input: GateInput = {
    body: IMPLEMENTATION_BODY,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
    taskFilesForId: implementationTaskFiles,
  };
  const existing = evaluateGate(input);
  assert.equal(existing.ok, true, existing.message);

  const missing = changedPathsAtRange({ headSha: "head", git: () => "unexpected" });
  const unreadable = changedPathsAtRange({
    baseSha: "base",
    headSha: "head",
    git: () => {
      throw new Error("unknown revision");
    },
  });
  assert.equal(missing, undefined);
  assert.equal(unreadable, undefined);
  assert.equal(planTaskFilesResolver(join(tmpdir(), "rmd-acceptance-gate-no-plan")), undefined);
  for (const changedPaths of [missing, [], unreadable]) {
    assert.deepEqual(evaluateGate({ ...input, changedPaths }), existing);
  }
  assert.deepEqual(
    evaluateGate({
      ...input,
      changedPaths: ["plan/tasks.d/W1-T3149.yaml"],
      taskFilesForId: () => {
        throw new Error("unreadable plan record");
      },
    }),
    existing,
  );
});

test("W1-T3149 criterion 5 mutation: removing only the structural predicate makes the #4573 shape pass", async () => {
  const mutant = await structuralPredicateMutant();
  try {
    const result = mutant.evaluateGate({
      body: IMPLEMENTATION_BODY,
      authorLogin: "a-human",
      trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
      changedPaths: ["plan/tasks.d/W1-T3149.yaml"],
      taskFilesForId: implementationTaskFiles,
    });
    assert.equal(result.ok, true, result.message);
  } finally {
    mutant.cleanup();
  }
});

test("W1-T3414: a trailer added by a follow-up commit is refused even when the PR body has none", () => {
  const calls: string[][] = [];
  const trailers = commitTaskTrailersAtRange({
    baseSha: "base",
    headSha: "head",
    git(args) {
      calls.push(args);
      return [
        "a".repeat(40), "filing task", "filing task\n\nNo trailer here",
        "b".repeat(40), "chore: follow-up", "chore: follow-up\n\nRemudero-Task: W1-T3101", "",
      ].join("\0");
    },
  });
  assert.deepEqual(calls, [["log", "-z", "--format=%H%x00%s%x00%B", "base..head"]]);
  assert.deepEqual(trailers, [{ sha: "b".repeat(40), subject: "chore: follow-up", taskId: IMPLEMENTATION_TASK }]);

  const result = evaluateGate({
    body: "## Acceptance\n\n- claim: plan filing\n  proof: grep: W1-T3414 in plan/tasks.d/W1-T3414.yaml\n",
    authorLogin: "a-human",
    changedPaths: ["plan/tasks.d/W1-T3414.yaml"],
    taskFilesForId: implementationTaskFiles,
    trailerCommits: trailers,
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "follow-up-implementation-trailer");
  assert.match(result.message, new RegExp(`Commit ${"b".repeat(40)}`));
  assert.match(result.message, /chore: follow-up/);
  assert.match(result.message, /src\/lib\/skill-workshop\.ts/);
  assert.match(result.message, /Remove the trailer from that commit/);
  assert.match(result.message, /include the implementation changes/);
});

test("W1-T3414: source-changing and plan-only task controls pass, and unreadable commit history preserves the existing verdict", () => {
  const followup = [{ sha: "c".repeat(40), subject: "chore: follow-up", taskId: IMPLEMENTATION_TASK }];
  const sourceChanging = evaluateGate({
    body: IMPLEMENTATION_BODY,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
    changedPaths: ["src/lib/skill-workshop.ts"],
    taskFilesForId: implementationTaskFiles,
    trailerCommits: followup,
  });
  assert.equal(sourceChanging.ok, true, sourceChanging.message);

  const planOnly = evaluateGate({
    body: "Remudero-Task: W1-TPLAN\n",
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === "W1-TPLAN",
    changedPaths: ["plan/tasks.d/W1-TPLAN.yaml"],
    taskFilesForId: (taskId) => (taskId === "W1-TPLAN" ? ["plan/tasks.d/W1-TPLAN.yaml"] : undefined),
    trailerCommits: [{ sha: "d".repeat(40), subject: "chore: filing", taskId: "W1-TPLAN" }],
  });
  assert.equal(planOnly.ok, true, planOnly.message);

  const unreadableTaskDeclaration = evaluateGate({
    body: "## Acceptance\n\n- claim: plan filing\n  proof: grep: W1-T3414 in plan/tasks.d/W1-T3414.yaml\n",
    authorLogin: "a-human",
    changedPaths: ["plan/tasks.d/W1-T3414.yaml"],
    taskFilesForId: () => {
      throw new Error("plan unreadable");
    },
    trailerCommits: followup,
  });
  assert.equal(unreadableTaskDeclaration.ok, true, unreadableTaskDeclaration.message);

  const existing = evaluateGate({
    body: IMPLEMENTATION_BODY,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
    changedPaths: ["src/lib/skill-workshop.ts"],
    taskFilesForId: implementationTaskFiles,
  });
  assert.deepEqual(
    evaluateGate({
      body: IMPLEMENTATION_BODY,
      authorLogin: "a-human",
      trailerResolves: (taskId) => taskId === IMPLEMENTATION_TASK,
      changedPaths: ["src/lib/skill-workshop.ts"],
      taskFilesForId: implementationTaskFiles,
      trailerCommits: commitTaskTrailersAtRange({ baseSha: "base", headSha: "head", git: () => { throw new Error("unknown revision"); } }),
    }),
    existing,
  );
});

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

// ── main()'s own refusal arm, in-process ──────────────────────────────────────────────────────
//
// The CLI-level tests above spawn the script, and a subprocess's coverage is not this run's, so
// main's early return on an unresolvable event path was never observed here. `main` is exported
// for exactly this: the direct-execution guard at the bottom of the script still gates the real
// invocation, so exporting it adds no behaviour. process.exitCode is saved and restored around
// each call — leaving it set would fail this suite's own process.

async function withExitCode(fn: () => void): Promise<{ exitCode: typeof process.exitCode; err: string[]; out: string[] }> {
  const priorExit = process.exitCode;
  const err: string[] = [];
  const out: string[] = [];
  const realErr = console.error;
  const realOut = console.log;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    fn();
    return { exitCode: process.exitCode, err, out };
  } finally {
    console.error = realErr;
    console.log = realOut;
    process.exitCode = priorExit;
  }
}

test("W1-T1060: main REFUSES with exit 1 and the named reason when no event path can be resolved", async () => {
  const priorEnv = process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_PATH;
  try {
    const r = await withExitCode(() => main([]));
    assert.equal(r.exitCode, 1, "an unresolvable event path is a refusal, not a pass");
    assert.equal(r.err.length, 1, "the refusal is reported once, on stderr");
    assert.match(r.err[0], /REFUSED — no event payload path/);
    assert.deepEqual(r.out, [], "a refusal prints no OK line");
  } finally {
    if (priorEnv === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = priorEnv;
  }
});

// The positive control: the SAME entry point, handed a resolvable path, gets past the refusal
// above — so the exit 1 is that branch and not main refusing everything.
test("W1-T1060: main gets past the event-path refusal when a path IS resolvable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-acceptance-author-gate-main-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body: "## Acceptance\n- a | grep: x in y\n", user: { login: "someone" } } }));
  try {
    const r = await withExitCode(() => main(["--event-path", eventPath]));
    assert.ok(
      !r.err.some((l) => /no event payload path/.test(l)),
      "the event-path refusal is not reached when the path resolves",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
