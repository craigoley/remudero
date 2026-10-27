import assert from "node:assert/strict";
import test from "node:test";

// Read through the namespaces, so this file still LOADS at a base that lacks a symbol and fails per test.
import * as sweep from "#src/lib/sweep.js";
import * as logs from "#src/lib/tick-read-worker.js";

// W1-T10816 — actions/upload-artifact prints `Finished uploading artifact content to blob storage!` before
// `Finalizing artifact upload`, never W1-T3194's synthetic `artifact upload completed successfully`, so the
// intermediary-403 signature matched no real log. TRANSCRIPT is CI run 38955270104's upload step (#12415,
// the lines W1-T9932 copied verbatim), with its finalize error swapped for an intermediary 403.
const FORBIDDEN =
  "##[error]Failed to FinalizeArtifact: Received non-retryable error: Failed request: (403) Forbidden: Error from intermediary";
const TRANSCRIPT = [
  "2026-10-16T19:32:22.0090164Z 1..558",
  "2026-10-16T19:32:22.0090381Z # tests 558",
  "2026-10-16T19:32:22.0090606Z # suites 0",
  "2026-10-16T19:32:22.0090816Z # pass 558",
  "2026-10-16T19:32:22.0091024Z # fail 0",
  "2026-10-16T19:32:22.0091232Z # cancelled 0",
  "2026-10-16T19:32:22.0091452Z # skipped 0",
  "2026-10-16T19:32:22.0091652Z # todo 0",
  "2026-10-16T19:32:22.0091880Z # duration_ms 139537.290157",
  "2026-10-16T19:32:22.0388049Z test-tier-manifest: rest run complete — 66/66 file(s) reported, # tests 558, # fail 0.",
  "2026-10-16T19:32:22.0841136Z ##[group]Run node scripts/flake-screen.mjs --shard 7",
  "2026-10-16T19:32:22.0841535Z ^[[36;1mnode scripts/flake-screen.mjs --shard 7^[[0m",
  "2026-10-16T19:32:22.0873640Z shell: /usr/bin/bash -e {0}",
  "2026-10-16T19:32:22.0874712Z ##[endgroup]",
  "2026-10-16T19:32:22.1347469Z flake-screen: shard 7 — 0 added test file(s); shard 1 screens them.",
  "2026-10-16T19:32:22.1442168Z ##[group]Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "2026-10-16T19:32:22.1442585Z with:",
  "2026-10-16T19:32:22.1442828Z   name: flake-retry-shard-7",
  "2026-10-16T19:32:22.1443122Z   path: /home/runner/work/_temp/flake-retry",
  "2026-10-16T19:32:22.1443430Z   retention-days: 1",
  "2026-10-16T19:32:22.1443686Z   if-no-files-found: ignore",
  "2026-10-16T19:32:22.1445606Z ##[endgroup]",
  "2026-10-16T19:32:22.2898460Z With the provided path, there will be 1 file uploaded",
  "2026-10-16T19:32:22.2904449Z Artifact name is valid!",
  "2026-10-16T19:32:22.2904995Z Root directory input is valid!",
  "2026-10-16T19:32:22.6390439Z Uploading artifact: flake-retry-shard-7.zip",
  "2026-10-16T19:32:22.6426564Z Beginning upload of artifact content to blob storage",
  "2026-10-16T19:32:22.9429823Z Uploaded bytes 138",
  "2026-10-16T19:32:23.0138714Z Finished uploading artifact content to blob storage!",
  "2026-10-16T19:32:23.0139782Z SHA256 digest of uploaded artifact is 0d2bc732c731a24a56ec5f34090942803c2920773d50152d6eeefb020a57ddb1",
  "2026-10-16T19:32:23.0140363Z Finalizing artifact upload",
  `2026-10-16T19:32:24.3697938Z ${FORBIDDEN}`,
  "If you are using self-hosted runners, please make sure your runner has access to all GitHub endpoints: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#communication-between-self-hosted-runners-and-github",
  "2026-10-16T19:32:25.6795796Z Post job cleanup.",
];

const JOB = "117156441241";
const SHARD = "ci-shard (7/8)";

/** The job log GitHub serves: 557 earlier passing tests, then the transcript. */
function jobLog(transcript: readonly string[] = TRANSCRIPT): string {
  const earlier = Array.from({ length: 558 }, (_, i) => `2026-10-16T19:32:21.0000000Z ok ${i + 1} - earlier test ${i + 1}`);
  return ["2026-10-16T19:29:59.0000000Z TAP version 13", ...earlier, ...transcript].join("\n");
}

function reduced(log: string): string {
  const reducer = logs.ciFailureRegionReducer(60);
  for (const line of log.split("\n")) reducer.push(line);
  return reducer.finish();
}

function edit(from: RegExp, to: string): string[] {
  return TRANSCRIPT.map((line) => from.test(line) ? line.replace(from, to) : line);
}

function classify(logTail: string, conclusion = "FAILURE") {
  return sweep.classifyCiInfrastructureFailure({ conclusion, logTail });
}

// The failed job's annotations as GitHub serves them for a finalize failure: the error and the runner hint.
const ANNOTATION = [
  FORBIDDEN.replace("##[error]", ""),
  "If you are using self-hosted runners, please make sure your runner has access to all GitHub endpoints: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#communication-between-self-hosted-runners-and-github",
];

test("W1-T10816: a real upload-artifact log that 403s while finalizing classifies as infrastructure", async () => {
  const log = jobLog();
  assert.ok(!/artifact upload completed successfully/i.test(log), "the fixture carries only the real wording");
  for (const region of [reduced(log), logs.extractCiFailureRegion(log, 60)]) {
    for (const line of ["Finished uploading artifact content to blob storage!", "Finalizing artifact upload", FORBIDDEN]) {
      assert.ok(region.split("\n").some((l) => l.trim() === line), `the region keeps ${JSON.stringify(line)}:\n${region}`);
    }
    assert.equal(classify(region), sweep.ARTIFACT_FINALIZE_INTERMEDIARY_403, region);
    assert.equal(sweep.ciInfrastructureMatchedError(region), FORBIDDEN);
    assert.match(sweep.ciInfrastructureFailedStep(region) ?? "", /^Run actions\/upload-artifact@/);
  }
  // The 403 needs no passing summary: the same upload step alone, as a non-test job prints it, classifies too.
  const bare = TRANSCRIPT.filter((l) => !/# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)|1\.\.558|file\(s\) reported/.test(l));
  assert.equal(classify(bare.join("\n")), sweep.ARTIFACT_FINALIZE_INTERMEDIARY_403);
  // The annotation names only the 403, so the read goes on to the job log for the region with the upload lines.
  const rollup = [{ name: SHARD, conclusion: "FAILURE", detailsUrl: `https://github.com/o/r/actions/runs/38955270104/job/${JOB}` }];
  const [read] = await logs.fetchCiFailuresAsync("o", "r", rollup, 60, { fetchAnnotations: () => ANNOTATION, fetchJobLog: () => log });
  assert.equal(read?.tailSource, "log");
  assert.deepEqual(read?.annotationFallback, { outcome: "artifact-finalize-only" });
  assert.equal(classify(read?.logTail ?? "", String(read?.conclusion)), sweep.ARTIFACT_FINALIZE_INTERMEDIARY_403);
  // W1-T3194's synthetic wording still classifies.
  assert.equal(classify(["Artifact upload completed successfully!", "Finalizing artifact upload",
    "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary"].join("\n")), sweep.ARTIFACT_FINALIZE_INTERMEDIARY_403);
});

test("W1-T10816: a real-wording finalize log without the proven 403 shape stays a genuine red", () => {
  const variants: Record<string, string> = {
    "no upload line": reduced(jobLog(TRANSCRIPT.filter((l) => !/Finished uploading artifact content/.test(l)))),
    "the 403 before the upload": [FORBIDDEN, "Finished uploading artifact content to blob storage!", "Finalizing artifact upload"].join("\n"),
    "the 403 before finalizing": ["Finished uploading artifact content to blob storage!", FORBIDDEN, "Finalizing artifact upload"].join("\n"),
    "a generic 403 with no intermediary": reduced(jobLog(edit(/: Error from intermediary$/, ""))),
    "a 404": reduced(jobLog(edit(/\(403\) Forbidden/, "(404) Not Found"))),
    "permission wording": reduced(jobLog(edit(/Error from intermediary$/, "Error from intermediary: Resource not accessible by integration"))),
    "a failing count": reduced(jobLog(edit(/# fail 0$/, "# fail 1"))),
    "an AssertionError": `${reduced(jobLog())}\nAssertionError [ERR_ASSERTION]: expected 1 to equal 2`,
    "a TAP not ok": `${reduced(jobLog())}\nnot ok 559 - a real failure`,
    "a TS error": `${reduced(jobLog())}\nsrc/x.ts(1,1): error TS2322: Type 'string' is not assignable`,
  };
  for (const [shape, logTail] of Object.entries(variants)) {
    assert.equal(classify(logTail), undefined, `${shape}:\n${logTail}`);
  }
  assert.equal(classify(reduced(jobLog()), "CANCELLED"), undefined, "a CANCELLED conclusion");
  assert.equal(classify(reduced(jobLog()), "SUCCESS"), undefined, "a SUCCESS conclusion");
});
