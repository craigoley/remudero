import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reviewerCodeRecoveryFromLoadedModule } from "../src/run-task.js";

const runTaskSource = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

test("W1-T3581 daemon wires loaded reviewer provenance into both sweep paths", () => {
  const daemonWiring = runTaskSource.slice(
    runTaskSource.indexOf("const daemonModuleRepoDir ="),
    runTaskSource.indexOf("// W1-T117/W1-T356: the per-poll half of the orphan sweep"),
  );
  assert.match(daemonWiring, /daemonModuleRepoDir = dirname\(dirname\(fileURLToPath\(import\.meta\.url\)\)\)/);
  assert.match(daemonWiring, /reviewerCodeRecoveryFromLoadedModule\(daemonModuleRepoDir, daemonLoadedCodeSha\)/);
  assert.match(daemonWiring, /sweep: buildSweepHook\([\s\S]*boardSnapshotFor\(target\.owner, target\.repo\),\s*reviewerCodeRecovery,/);
  assert.match(daemonWiring, /sweepLight: buildSweepLightHook\([\s\S]*log,\s*reviewerCodeRecovery,/);

  const fullHook = runTaskSource.slice(
    runTaskSource.indexOf("export function buildSweepHook("),
    runTaskSource.indexOf("export function buildSweepLightHook("),
  );
  assert.match(fullHook, /behindMainByPr,\s*reviewerCodeRecovery,/);
  const lightHook = runTaskSource.slice(runTaskSource.indexOf("export function buildSweepLightHook("));
  assert.match(lightHook, /ledgerPath,\s*runId,\s*log,\s*reviewerCodeRecovery,/);

  const ancestryCalls: string[][] = [];
  const recovery = reviewerCodeRecoveryFromLoadedModule(
    "/module-root",
    "loaded-sha",
    ((_command: string, args: string[]) => {
      ancestryCalls.push(args);
      return { status: 0 };
    }) as never,
  );
  assert.equal(recovery.isLoadedCodeAtOrAfter("required-sha"), true);
  assert.deepEqual(ancestryCalls, [["-C", "/module-root", "merge-base", "--is-ancestor", "required-sha", "loaded-sha"]]);
  assert.equal(reviewerCodeRecoveryFromLoadedModule("/module-root", undefined).isLoadedCodeAtOrAfter("required"), false);
});
