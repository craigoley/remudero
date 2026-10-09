import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** One ESM link failure a base-side proof run printed: `importer` names `name` from `specifier`, which lacks it. */
export interface MissingExportGap {
  importer: string;
  specifier: string;
  name: string;
}

/** The ESM missing-export failures in a proof run's output, or `undefined` when the output carries none, or carries
 *  ANY other load error alongside them — only a run that failed for this one reason is a candidate. */
export function missingExportGaps(output: string): MissingExportGap[] | undefined {
  const missingExportRe = /The requested module '([^']+)' does not provide an export named '([^']+)'/;
  const errorHeadlineRe = /^#?\s*([A-Za-z]*Error)(?:\s*\[[A-Z_]+\])?:\s/;
  const importerLineRe = /^#?\s*(\/\S+?):\d+\s*$/;
  if (/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(output)) return undefined;
  const gaps: MissingExportGap[] = [];
  let importer: string | undefined;
  for (const line of output.split("\n")) {
    const at = importerLineRe.exec(line);
    if (at) importer = at[1];
    if (!errorHeadlineRe.test(line)) continue;
    const m = missingExportRe.exec(line);
    if (!m || importer === undefined) return undefined;
    gaps.push({ importer, specifier: m[1]!, name: m[2]! });
  }
  return gaps.length > 0 ? gaps : undefined;
}

function sourceCandidates(path: string): string[] {
  if (path.endsWith(".js")) return [path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx", path];
  if (path.endsWith(".mjs")) return [path.slice(0, -4) + ".mts", path];
  return [path];
}

function readModule(root: string, repoPath: string): { path: string; text: string } | undefined {
  for (const candidate of sourceCandidates(repoPath)) {
    const full = join(root, candidate);
    if (existsSync(full)) return { path: candidate, text: readFileSync(full, "utf8") };
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declaresExport(text: string, name: string): boolean {
  const n = escapeRegExp(name);
  const declared = new RegExp(
    `export\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?` +
      `(?:function\\*?|const|let|var|class|enum|interface|type)\\s+${n}\\b`,
  );
  const listed = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${n}\\b[^}]*\\}`);
  return declared.test(text) || listed.test(text);
}

/** The reason a base-side proof run that could not LOAD is nonetheless a genuine miss, or `undefined`. True only when
 *  every failure is a missing named export whose module exists at the base WITHOUT that export (and with no
 *  `export *` that could supply it) and exports it at the head: the base simply lacks code this diff adds. Anything
 *  unproven — a relative path outside either tree, an unreadable module, a wildcard re-export — stays undefined, so
 *  the caller keeps its fail-closed base_unknown. */
export function baseLacksPrAddedExports(output: string, baseCwd: string, headCwd: string): string | undefined {
  const gaps = missingExportGaps(output);
  if (gaps === undefined) return undefined;
  const named: string[] = [];
  for (const gap of gaps) {
    if (!isAbsolute(gap.importer) || !gap.specifier.startsWith(".")) return undefined;
    const importerRel = relative(baseCwd, gap.importer);
    if (importerRel.startsWith("..") || isAbsolute(importerRel)) return undefined;
    const moduleRel = join(dirname(importerRel), gap.specifier);
    if (moduleRel.startsWith("..")) return undefined;
    const base = readModule(baseCwd, moduleRel);
    const head = readModule(headCwd, moduleRel);
    if (base === undefined || head === undefined) return undefined;
    if (/export\s*\*\s*from/.test(base.text) || declaresExport(base.text, gap.name)) return undefined;
    if (!declaresExport(head.text, gap.name)) return undefined;
    named.push(`${gap.name} (${base.path})`);
  }
  return `base lacks export(s) ${named.join(", ")} that the PR adds — the test cannot link there, a genuine miss`;
}
