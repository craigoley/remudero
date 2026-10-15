#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgv, isMainModule } from "./lib/argv.mjs";
import { prepareReadMapCorpus, collectReadMapCorpus } from "./lib/read-map-corpus.mjs";

/** Operator opt-in only; no full test launch, workflow edit or activation is implied. */
export function main(argv) {
  const { values, positionals, helpRequested } = parseArgv(argv, { root: { type: "string" }, directory: { type: "string" }, output: { type: "string" } },
    { helpText: "read-map-corpus prepare --root <clean-repo> --directory <fresh-private-run> | collect --directory <run> --output <new-observation.json>\nprepare prints environment and a SECOND reporter/destination for the existing run; collect never emits a consumption-ready read map." });
  if (helpRequested) return 0;
  if (positionals.length !== 1 || !values.directory) return 2;
  if (positionals[0] === "prepare" && values.root && !values.output) { console.log(JSON.stringify(prepareReadMapCorpus(values.root, values.directory))); return 0; }
  if (positionals[0] === "collect" && !values.root && values.output) {
    const report = collectReadMapCorpus(values.directory);
    writeFileSync(values.output, JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ state: report.state, expectedSuites: report.expectedSuites, observedSuites: report.observedSuites, problems: report.problems.length, liveNarrowingAllowed: false }));
    return report.state === "INCOMPLETE" ? 3 : 0;
  }
  return 2;
}
if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
