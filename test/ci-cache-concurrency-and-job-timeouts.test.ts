import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── R-50: cache npm, cancel superseded PR runs, bound every job with a timeout ─────────────
//
// docs/audits/recon-2026-09-05.md's R-50 measured (at f7ceb86): 17 workflow files, 34 jobs; a
// typical PR runs 32 jobs with 23 cold `npm ci` runs; all 16 `actions/setup-node` uses in
// ci.yml (24 across the whole fleet) carried no `cache:`; ci.yml had no `concurrency:` group,
// so a force-push mid-run cancelled nothing; 10 PR-firing jobs carried no `timeout-minutes`.
//
// This suite reads the real workflow files on disk — never a copy-pasted fixture — so a later
// edit to any of them is what these assertions actually read. Scoped to the fleet-wide
// invariants this task adds; test/workflow-job-timeouts.test.ts already owns ci.yml's own
// heavy/light timeout BAND (a narrower, pre-existing concern) and is unchanged by this file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const CI_YAML_PATH = join(WORKFLOWS_DIR, "ci.yml");
const CI_GATE_YAML_PATH = join(WORKFLOWS_DIR, "ci-gate.yml");

type WorkflowStep = {
  uses?: string; with?: Record<string, unknown>; id?: string; if?: string; run?: string;
  env?: Record<string, unknown>;
};
type WorkflowJob = {
  "timeout-minutes"?: number;
  if?: string;
  outputs?: Record<string, string>;
  uses?: string; // a job whose body IS a reusable-workflow call — no timeout-minutes is valid there
  steps?: WorkflowStep[];
};
type WorkflowDoc = {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, WorkflowJob>;
};

async function loadWorkflowFiles(): Promise<Array<{ file: string; doc: WorkflowDoc }>> {
  const names = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yml"));
  assert.ok(names.length >= 15, `expected at least the 15+ workflow files on record, got ${names.length}`);
  const out: Array<{ file: string; doc: WorkflowDoc }> = [];
  for (const name of names) {
    const raw = await readFile(join(WORKFLOWS_DIR, name), "utf8");
    out.push({ file: name, doc: parseYaml(raw) as WorkflowDoc });
  }
  return out;
}

function assertSetupCache(file: string, jobId: string, steps: WorkflowStep[], index: number): void {
  if (file === "ci.yml" && jobId === "coverage-ledger") {
    const context = "ci.yml: dependency-free coverage-ledger bootstrap";
    assert.doesNotMatch(steps.map(step => step.run ?? "").join("\n"),
      /\b(?:npm|npx|pnpm|yarn)\b|\bbun\s+(?:install|add|x)\b/,
      `${context} must not install dependencies anywhere in the job`);
    assert.equal(steps.length, 8, `${context} must retain ledger resolution and the three floor admission steps`);
    assert.equal(index, 1, `${context} must set up Node immediately after sparse checkout`);
    const [checkout, setup, resolve, publish, finish] = steps;
    assert.match(checkout?.uses ?? "", /^actions\/checkout@[a-f0-9]{40}$/i);
    assert.equal(checkout?.with?.["fetch-depth"], 2);
    assert.equal(checkout?.with?.["sparse-checkout-cone-mode"], false);
    assert.deepEqual(String(checkout?.with?.["sparse-checkout"]).split(/\s+/).filter(Boolean),
      [".nvmrc", "package.json", "package-lock.json", "test/setup/tmp-hygiene.ts",
        "scripts/", "src/lib/plan-scope.ts", "src/lib/rule-suites.ts"],
      `${context} must carry the floor policy inputs without installing dependencies`);
    assert.match(setup?.uses ?? "", /^actions\/setup-node@[a-f0-9]{40}$/i);
    assert.equal(setup?.with?.cache, undefined, `${context} must remain uncached without a lockfile`);
    assert.deepEqual(setup?.with, { "node-version-file": ".nvmrc" });
    assert.equal(setup?.if, undefined, `${context} must preserve the Node pin on every event`);
    assert.equal(resolve?.id, "resolve");
    assert.equal(resolve?.uses, undefined);
    assert.equal(resolve?.if, undefined);
    assert.deepEqual(resolve?.env, { GH_TOKEN: "${{ github.token }}" });
    const body = resolve?.run ?? "";
    assert.match(body, /^\s*set\s+-euo\s+pipefail\b/);
    assert.ok(body.includes('CHOICE_NAME="coverage-ledger-choice-${GITHUB_RUN_ID}"'),
      `${context} must bind the immutable choice to this run`);
    assert.ok(body.includes('[ "${GITHUB_RUN_ATTEMPT:-1}" = "1" ] || die'),
      `${context} must refuse a lost rerun choice`);
    const runBodies = steps.map(step => step.run ?? "").join("\n").replace(/\\\n\s*/g, " ");
    const nodeCommands = runBodies.split("\n")
      .map(line => line.trim()).filter(line => /\bnode\s/.test(line));
    assert.deepEqual([...runBodies.matchAll(/\bnode\s+(\S+)/g)].map(match => match[1]),
      ["scripts/diff-class.mjs", "scripts/test-tier-manifest.mjs", "scripts/test-tier-manifest.mjs",
        "scripts/coverage-floor.mjs"],
      `${context} must run only the dependency-free classifier, ledger and floor CLIs`);
    assert.match(nodeCommands[0]!, /--coverage-class\b/);
    assert.match(nodeCommands[0]!, /--changed-files\s+ledger-changed-files\.txt\b/);
    for (const [command, verb, directory] of [
      [nodeCommands[1]!, "verify", "INCOMING"], [nodeCommands[2]!, "write", "PUBLISH"],
    ]) {
      assert.ok(command!.includes(`--${verb}-resolved-ledger`));
      for (const [flag, value] of [["resolved-ledger", `$${directory}/ledger-choice.json`],
        ["snapshot", `$${directory}/ledger-snapshot.manifest`], ["github-output", "$GITHUB_OUTPUT"]]) {
        assert.ok(command!.replace(/\s+/g, " ").includes(`--${flag} "${value}"`),
          `${context} must keep the ${verb} CLI's ${flag} identity`);
      }
    }
    assert.ok(nodeCommands[2]!.includes('"${FLAGS[@]}"'), `${context} must retain the selected source/artifact flags`);
    assert.equal(publish?.id, "publish");
    assert.equal(publish?.if, undefined);
    assert.match(publish?.uses ?? "", /^actions\/upload-artifact@[a-f0-9]{40}$/i);
    assert.deepEqual(publish?.with, {
      name: "coverage-ledger-choice-${{ github.run_id }}", path: "${{ runner.temp }}/coverage-ledger-publish",
      "retention-days": 1, "if-no-files-found": "ignore",
    }, `${context} must publish the immutable run identity without overwrite`);
    assert.equal(finish?.id, "finish");
    assert.equal(finish?.if, undefined);
    assert.equal(finish?.uses, undefined);
    assert.deepEqual(finish?.env, {
      DIGEST: "${{ steps.resolve.outputs.digest }}", EXISTING_ID: "${{ steps.resolve.outputs.existing_artifact_id }}",
      PUBLISHED_ID: "${{ steps.publish.outputs.artifact-id }}",
    });
    assert.ok(finish?.run?.includes('[[ "$ARTIFACT_ID" =~ ^[0-9]+$ ]] ||'),
      `${context} must refuse an unpublished identity`);
    for (const step of [checkout, setup, publish]) assert.equal(step?.run, undefined);
    const [select, floorPublish, floorFinish] = steps.slice(5);
    assert.equal(select?.id, "floor-select");
    assert.match(select?.run ?? "", /timeout 30s node scripts\/coverage-floor\.mjs select/);
    assert.equal(floorPublish?.id, "floor-publish");
    assert.equal(floorPublish?.if, "steps.floor-select.outputs.decision == 'narrow'");
    assert.match(floorPublish?.uses ?? "", /^actions\/upload-artifact@[a-f0-9]{40}$/i);
    assert.deepEqual(floorPublish?.with, {
      name: "coverage-floor-pin-${{ github.run_attempt }}", path: "coverage-floor-pin",
      "retention-days": 1, "if-no-files-found": "error",
    });
    assert.equal(floorFinish?.id, "floor-finish");
    assert.deepEqual(floorFinish?.env, {
      DECISION: "${{ steps.floor-select.outputs.decision }}",
      REASON: "${{ steps.floor-select.outputs.reason }}", PUBLISHED: "${{ steps.floor-publish.outcome }}",
    });
    return;
  }
  const step = steps[index]!;
  if (step.with?.cache === "npm") return;
  const context = `${file}: job '${jobId}'s uncached setup-node`;
  assert.equal(file, "ci.yml", `${context} must not permit cold installs in other workflows`);
  assert.equal(jobId, "ci", `${context} must only bootstrap the guarded ci admission`);
  assert.equal(step.with?.cache, undefined, `${context} must not replace npm caching with another cache`);
  assert.equal(steps[index + 1]?.id, "admission", `${context} must immediately precede admission`);
  assert.match(steps[index + 1]?.run ?? "", /node scripts\/ci-shard-admission\.mjs/);
  assert.doesNotMatch(steps[index + 1]?.run ?? "", /(^|\s)(?:npm|npx)\s/,
    `${context} must keep admission dependency-free`);
  const restore = steps[index + 2];
  assert.equal(restore?.uses, step.uses, `${context} must restore the same pinned setup action`);
  assert.equal(restore?.with?.cache, "npm", `${context} must retain cache: npm for admitted work`);
  assert.equal(restore?.if, "${{ steps.admission.outputs.setup != 'false' }}",
    `${context} must restore the cache for every admitted or uncertain shard`);
  assert.ok(!steps.slice(0, index + 3).some(candidate => /\bnpm\s+ci\b/.test(candidate.run ?? "")),
    `${context} must not install before the cached setup`);
  const install = steps.slice(index + 3).find(candidate => /\bnpm\s+ci\b/.test(candidate.run ?? ""));
  assert.ok(install?.run?.includes('"${{ steps.admission.outputs.setup }}" != "false"'),
    `${context} must guard the actual npm installation with the same admission`);
}

test("R-50: setup caches npm unless it only bootstraps guarded dependency-free admission", async () => {
  const files = await loadWorkflowFiles();
  let setupNodeUses = 0;
  for (const { file, doc } of files) {
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        setupNodeUses += 1;
        assertSetupCache(file, jobId, steps, index);
      }
    }
  }
  assert.ok(setupNodeUses >= 20, `expected at least the 24 actions/setup-node uses on record, got ${setupNodeUses}`);
});

test("npm cache census refuses a missing cache, mismatched guard or installer before admission", async () => {
  const doc = parseYaml(await readFile(CI_YAML_PATH, "utf8")) as WorkflowDoc;
  const steps = doc.jobs.ci!.steps!;
  const index = steps.findIndex(step => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(index >= 0);
  assertSetupCache("ci.yml", "ci", steps, index);
  const missingCache = structuredClone(steps);
  delete missingCache[index + 2]!.with!.cache;
  assert.throws(() => assertSetupCache("ci.yml", "ci", missingCache, index), /retain cache: npm/);
  const wrongGuard = structuredClone(steps);
  wrongGuard[index + 2]!.if = "${{ false }}";
  assert.throws(() => assertSetupCache("ci.yml", "ci", wrongGuard, index), /every admitted or uncertain/);
  const earlyInstall = structuredClone(steps);
  earlyInstall.unshift({ run: "npm ci" });
  assert.throws(() => assertSetupCache("ci.yml", "ci", earlyInstall, index + 1), /install before/);
  const dependentAdmission = structuredClone(steps);
  dependentAdmission[index + 1]!.run += "\nnpx install-something";
  assert.throws(() => assertSetupCache("ci.yml", "ci", dependentAdmission, index), /dependency-free/);
  assert.throws(() => assertSetupCache("other.yml", "ci", steps, index), /other workflows/);
});

test("uncached ledger bootstrap preserves its pin and identity without admitting another installer", async () => {
  const doc = parseYaml(await readFile(CI_YAML_PATH, "utf8")) as WorkflowDoc;
  const job = doc.jobs["coverage-ledger"]!;
  const steps = job.steps!;
  const index = steps.findIndex(step => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(job["timeout-minutes"], 1);
  assert.equal(job.if, undefined);
  assert.deepEqual(job.outputs, {
    artifact_id: "${{ steps.finish.outputs.artifact_id }}", digest: "${{ steps.resolve.outputs.digest }}",
    floor_decision: "${{ steps.floor-finish.outputs.decision }}",
    floor_reason: "${{ steps.floor-finish.outputs.reason }}",
    floor_pin_digest: "${{ steps.floor-select.outputs.pin_digest }}",
    floor_artifact: "coverage-floor-pin-${{ github.run_attempt }}",
  });
  assert.match(await readFile(join(REPO_ROOT, ".nvmrc"), "utf8"), /^\d+\.\d+\.\d+\s*$/);
  assertSetupCache("ci.yml", "coverage-ledger", steps, index);
  for (const installer of ["npm ci", "npx install-something", "pnpm install", "yarn install", "bun install"]) {
    for (const at of [0, steps.length]) {
      const planted = structuredClone(steps);
      planted.splice(at, 0, { run: installer });
      assert.throws(() => assertSetupCache("ci.yml", "coverage-ledger", planted, index + (at === 0 ? 1 : 0)),
        /must not install dependencies anywhere/, `${installer} at step ${at} must not qualify as bootstrap`);
    }
    const inside = structuredClone(steps);
    inside[2]!.run += `\n${installer}`;
    assert.throws(() => assertSetupCache("ci.yml", "coverage-ledger", inside, index), /must not install dependencies anywhere/);
  }
  for (const cache of ["npm", "yarn", "pnpm"]) {
    const cached = structuredClone(steps);
    cached[index]!.with!.cache = cache;
    assert.throws(() => assertSetupCache("ci.yml", "coverage-ledger", cached, index), /must remain uncached/);
  }
  assert.throws(() => assertSetupCache("other.yml", "coverage-ledger", steps, index), /other workflows/);
  assert.throws(() => assertSetupCache("ci.yml", "other-job", steps, index), /guarded ci admission/);
  const changed = (mutate: (copy: WorkflowStep[]) => void) => {
    const copy = structuredClone(steps); mutate(copy);
    assert.throws(() => assertSetupCache("ci.yml", "coverage-ledger", copy, index));
  };
  for (const floating of ["actions/setup-node@v4", "other/setup-node@" + "a".repeat(40)]) {
    changed(copy => { copy[index]!.uses = floating; });
  }
  for (const at of [0, index, 3]) {
    const repinned = structuredClone(steps);
    repinned[at]!.uses = repinned[at]!.uses!.replace(/@.*/, "@" + "b".repeat(40));
    assertSetupCache("ci.yml", "coverage-ledger", repinned, index);
  }
  changed(copy => { copy[index]!.with!["node-version-file"] = ".other-node-version"; });
  changed(copy => { copy[0]!.with!["sparse-checkout"] += "src/unrelated.ts\n"; });
  changed(copy => { copy[0]!.with!["sparse-checkout"] = String(copy[0]!.with!["sparse-checkout"]).replace("package-lock.json\n", ""); });
  changed(copy => { copy[2]!.run += "\nnode scripts/unrelated.mjs"; });
  changed(copy => { copy[4]!.run += "\nnode scripts/unrelated.mjs"; });
  changed(copy => {
    const verifierFlags = '--snapshot "$INCOMING/ledger-snapshot.manifest" --github-output "$GITHUB_OUTPUT"';
    assert.ok(copy[2]!.run!.includes(verifierFlags), "the same-line plant must follow the complete verifier flags");
    copy[2]!.run = copy[2]!.run!.replace(verifierFlags,
      verifierFlags + "; node scripts/unrelated.mjs");
  });
  changed(copy => { copy[2]!.run = copy[2]!.run!.replace("${GITHUB_RUN_ID}", "another-run"); });
  changed(copy => { copy[2]!.run = copy[2]!.run!.replace("--verify-resolved-ledger", "--select-all"); });
  changed(copy => { copy[2]!.run = copy[2]!.run!.replace("--write-resolved-ledger", "--select-all"); });
  changed(copy => { copy[3]!.with!.overwrite = true; });
  changed(copy => { copy[4]!.env!.PUBLISHED_ID = "another-artifact"; });
});

// ── acceptance 2: ci.yml declares a concurrency group that cancels only PR runs ─────────────

test("R-50: ci.yml declares a concurrency group, PR-only cancel-in-progress", async () => {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as WorkflowDoc;
  assert.ok(doc.concurrency, "ci.yml must declare a top-level concurrency block");
  assert.equal(
    doc.concurrency!.group,
    "ci-${{ github.event.pull_request.number || github.ref }}",
    "ci.yml's concurrency group must key on the PR number (falling back to the ref for a push), " +
      "so a PR's own runs share one group and a push-to-main run shares a different one",
  );
  assert.equal(
    doc.concurrency!["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
    "cancel-in-progress must be conditioned on the event being a pull_request — a PR's superseded " +
      "run should cancel, but a push-to-main run (the only lane that runs the full suite against " +
      "main and the only coverage-ratchet run that reaches the fleet) must never cancel a sibling",
  );
  // The literal string must also appear in the raw text — guards against a parser normalising
  // an equivalent-looking but differently-spelled expression into the same JS value.
  assert.ok(raw.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

// ── acceptance 3: every job in every PR-firing workflow declares timeout-minutes ───────────

/** A workflow "fires on a PR" when its `on:` block declares a `pull_request` trigger at all —
 *  path-filtered or not, since a path-filtered PR trigger still runs a job that can hang. */
function firesOnPullRequest(doc: WorkflowDoc): boolean {
  return Object.prototype.hasOwnProperty.call(doc.on ?? {}, "pull_request");
}

test("R-50: every job in every PR-firing workflow declares a positive timeout-minutes", async () => {
  const files = await loadWorkflowFiles();
  const prFiring = files.filter(({ doc }) => firesOnPullRequest(doc));
  assert.ok(prFiring.length >= 10, `expected at least 10 PR-firing workflow files, got ${prFiring.length}`);

  let checked = 0;
  for (const { file, doc } of prFiring) {
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      if (typeof job.uses === "string") {
        // A job whose body is a reusable-workflow call accepts no timeout-minutes key at all
        // (GitHub Actions schema: name/uses/with/secrets/needs/if/permissions/strategy only) —
        // adding one here would be invalid YAML for this job shape, not a stricter bound.
        continue;
      }
      checked += 1;
      const value = job["timeout-minutes"];
      assert.ok(
        typeof value === "number" && Number.isFinite(value) && value > 0,
        `${file}: job '${jobId}' (a PR-firing workflow) has no positive timeout-minutes (got ` +
          `${JSON.stringify(value)}) — it would inherit GitHub's 360-minute default`,
      );
    }
  }
  assert.ok(checked >= 25, `expected at least 25 non-reusable-workflow jobs checked, got ${checked}`);
});

// ── acceptance 4: ci-gate's own timeout exceeds its WAIT_CAP_SECONDS + grace, in minutes ───

test("R-50: ci-gate.yml's job timeout exceeds WAIT_CAP_SECONDS + GRACE_WINDOW_SECONDS", async () => {
  const raw = await readFile(CI_GATE_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as {
    jobs: Record<string, { "timeout-minutes"?: number; env?: Record<string, string> }>;
  };
  const gate = doc.jobs["ci-gate"];
  assert.ok(gate, "ci-gate.yml must declare a `ci-gate` job");

  const waitCapSeconds = Number(gate!.env?.WAIT_CAP_SECONDS);
  const graceWindowSeconds = Number(gate!.env?.GRACE_WINDOW_SECONDS);
  assert.ok(
    Number.isFinite(waitCapSeconds) && waitCapSeconds > 0,
    `ci-gate.yml must declare a positive env.WAIT_CAP_SECONDS, got ${gate!.env?.WAIT_CAP_SECONDS}`,
  );
  assert.ok(
    Number.isFinite(graceWindowSeconds) && graceWindowSeconds > 0,
    `ci-gate.yml must declare a positive env.GRACE_WINDOW_SECONDS, got ${gate!.env?.GRACE_WINDOW_SECONDS}`,
  );

  const timeoutMinutes = gate!["timeout-minutes"];
  assert.ok(
    typeof timeoutMinutes === "number" && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0,
    `ci-gate.yml's ci-gate job has no positive timeout-minutes (got ${JSON.stringify(timeoutMinutes)})`,
  );

  const derivedFloorMinutes = (waitCapSeconds + graceWindowSeconds) / 60;
  assert.ok(
    timeoutMinutes! > derivedFloorMinutes,
    `ci-gate's timeout-minutes (${timeoutMinutes}m) must exceed WAIT_CAP_SECONDS + GRACE_WINDOW_SECONDS ` +
      `expressed in minutes (${derivedFloorMinutes}m = ${waitCapSeconds}s + ${graceWindowSeconds}s) — ` +
      "below that, the job's own external timeout can fire before its internal wait+grace logic ever " +
      "concludes, misattributing a slow-but-honest run as a hung job",
  );
});

test("coverage-shard has headroom beyond the measured 39m ceiling but remains below ci-gate's wait cap", async () => {
  const ciRaw = await readFile(CI_YAML_PATH, "utf8");
  const ci = parseYaml(ciRaw) as { jobs: Record<string, { "timeout-minutes"?: number }> };
  const gateRaw = await readFile(CI_GATE_YAML_PATH, "utf8");
  const gate = parseYaml(gateRaw) as { jobs: Record<string, { env?: Record<string, string> }> };
  const coverageTimeout = ci.jobs["coverage-ratchet"]?.["timeout-minutes"];
  const waitCapSeconds = Number(gate.jobs["ci-gate"]?.env?.WAIT_CAP_SECONDS);
  assert.ok(coverageTimeout && coverageTimeout > 39,
    `coverage-shard must exceed its former 39m ceiling after run 37694060425 hit that bound; got ${coverageTimeout}`);
  assert.ok(Number.isFinite(waitCapSeconds) && coverageTimeout * 60 < waitCapSeconds,
    `coverage-shard timeout (${coverageTimeout}m) must stay strictly below ci-gate WAIT_CAP_SECONDS (${waitCapSeconds}s)`);
});


test("ledger bootstrap admits its classifier leaves and floor policy inputs without dependencies", async () => {
  const doc = (await loadWorkflowFiles()).find(entry => entry.file === "ci.yml")!.doc;
  const steps = doc.jobs["coverage-ledger"]!.steps!;
  const index = steps.findIndex(step => step.uses?.startsWith("actions/setup-node@"));
  assertSetupCache("ci.yml", "coverage-ledger", steps, index);
  const declared = String(steps[0]!.with!["sparse-checkout"]);
  for (const replacement of [
    declared.replace("src/lib/rule-suites.ts", ""),
    declared.replace("src/lib/plan-scope.ts", ""),
    declared.replace("src/lib/rule-suites.ts", "src/lib/"),
    declared.replace("package-lock.json", ""),
    declared.replace("test/setup/tmp-hygiene.ts", ""),
    declared + "package-lock.json\n", declared + "node_modules/\n", declared + "src/lib/unrelated.ts\n",
  ]) {
    const changed = structuredClone(steps);
    changed[0]!.with!["sparse-checkout"] = replacement;
    assert.throws(() => assertSetupCache("ci.yml", "coverage-ledger", changed, index),
      /must carry the floor policy inputs without installing dependencies/);
  }
});
