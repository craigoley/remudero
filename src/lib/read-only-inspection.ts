/** Explicit, allowlisted diagnostics: no config load, CLI housekeeping, credentials or self-sync. */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { ledgerGrepCommand } from "./report-commands.js";
import { buildSkillEffectivenessReport, renderSkillEffectivenessReport, SKILL_EFFECTIVENESS_LEDGER_STEPS } from "./skill-workshop.js";

export const READ_ONLY_INSPECTION_USAGE =
  "usage: rmd inspect --state-dir <absolute-dir> ledger-grep <pattern> | skill effectiveness <name>";

export function readOnlyInspectionCommand(rest: string[],
  readLedger: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
): number {
  let stateDir: string | undefined;
  let args: string[];
  try {
    const parsed = parseArgs({ args: rest, strict: true, allowPositionals: true,
      options: { "state-dir": { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (parsed.values.help) { console.log(READ_ONLY_INSPECTION_USAGE); return 0; }
    stateDir = parsed.values["state-dir"];
    args = parsed.positionals;
  } catch {
    console.error(READ_ONLY_INSPECTION_USAGE);
    return 2;
  }
  // Require an explicit existing target; never loadConfig(), which can provision a default HOME config.
  if (!stateDir || !isAbsolute(stateDir)) { console.error(READ_ONLY_INSPECTION_USAGE); return 2; }
  try {
    if (!statSync(stateDir).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error("rmd inspect: state directory is unavailable; nothing created");
    return 2;
  }
  if (args[0] === "ledger-grep" && args.length === 2) {
    return ledgerGrepCommand([args[1]!], { stateDir });
  }
  if (args[0] === "skill" && args[1] === "effectiveness" && args.length === 3) {
    try {
      const union = readLedger(stateDir, {
        step: SKILL_EFFECTIVENESS_LEDGER_STEPS, requireArchives: true, refuseIncomplete: true,
      });
      if (!union.ok) { console.error("rmd inspect: incomplete ledger union; no effectiveness claim"); return 1; }
      console.log(renderSkillEffectivenessReport(buildSkillEffectivenessReport(union.rows, args[2]!)));
      return 0;
    } catch {
      console.error("rmd inspect: unreadable ledger union; no effectiveness claim");
      return 1;
    }
  }
  console.error("rmd inspect: command is not an allowlisted read-only diagnostic\n" + READ_ONLY_INSPECTION_USAGE);
  return 2;
}
