import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
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
    // Node's TAP reporter escapes a leading hash; do not reinterpret other escapes.
    gaps.push({ importer, specifier: m[1]!.replace(/^\\#/, "#"), name: m[2]! });
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
    if (existsSync(full)) {
      const physical = relative(realpathSync(root), realpathSync(full));
      if (physical.startsWith("..") || isAbsolute(physical) || !lstatSync(full).isFile()) return undefined;
      return { path: candidate, text: readFileSync(full, "utf8") };
    }
  }
  return undefined;
}

/** Only one unconditional, local mapping in the nearest package scope is attestable here.
 * Conditional/ambiguous/changed maps remain UNKNOWN rather than guessing Node's resolution. */
function subpathModule(root: string, importerRel: string, specifier: string): { path: string; binding: string } | undefined {
  if (!specifier.startsWith("#") || /[\\%?\0]/.test(specifier) || specifier.split("/").includes("..")) return undefined;
  for (let scope = dirname(importerRel);; scope = dirname(scope)) {
    const file = join(root, scope, "package.json");
    if (existsSync(file)) {
      const st = lstatSync(file);
      const physical = relative(realpathSync(root), realpathSync(file));
      if (!st.isFile() || st.isSymbolicLink() || st.size > 65536 || physical.startsWith("..") || isAbsolute(physical)) return undefined;
      const imports: unknown = JSON.parse(readFileSync(file, "utf8")).imports;
      if (typeof imports !== "object" || imports === null || Array.isArray(imports)) return undefined;
      const matches = Object.entries(imports).flatMap(([key, target]) => {
        const pieces = key.split("*");
        if (pieces.length === 1) return key === specifier ? [{ key, target, middle: undefined }] : [];
        if (pieces.length !== 2 || !specifier.startsWith(pieces[0]!) || !specifier.endsWith(pieces[1]!) ||
            specifier.length < pieces[0]!.length + pieces[1]!.length) return [];
        return [{ key, target, middle: specifier.slice(pieces[0]!.length, specifier.length - pieces[1]!.length) }];
      });
      if (matches.length !== 1) return undefined;
      const { key, target, middle } = matches[0]!;
      if (typeof target !== "string" || !target.startsWith("./") || /[\\%?#\0]/.test(target) ||
          target.split("/").includes("..") || target.split("*").length > (middle === undefined ? 1 : 2)) return undefined;
      const mapped = middle === undefined ? target : target.replace("*", middle);
      if (mapped.includes("*")) return undefined;
      const path = join(scope, mapped);
      if (path.startsWith("..") || isAbsolute(path)) return undefined;
      return { path, binding: JSON.stringify([scope, key, target]) };
    }
    if (scope === ".") return undefined;
  }
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
  try {
  const gaps = missingExportGaps(output);
  if (gaps === undefined) return undefined;
  const named: string[] = [];
  for (const gap of gaps) {
    if (!isAbsolute(gap.importer)) return undefined;
    const importerRel = relative(baseCwd, gap.importer);
    if (importerRel.startsWith("..") || isAbsolute(importerRel)) return undefined;
    const baseMapping = gap.specifier.startsWith("#") ? subpathModule(baseCwd, importerRel, gap.specifier) : undefined;
    const headMapping = gap.specifier.startsWith("#") ? subpathModule(headCwd, importerRel, gap.specifier) : undefined;
    if (gap.specifier.startsWith("#") && (baseMapping === undefined || headMapping === undefined ||
        baseMapping.binding !== headMapping.binding || baseMapping.path !== headMapping.path)) return undefined;
    if (!gap.specifier.startsWith(".") && baseMapping === undefined) return undefined;
    const moduleRel = baseMapping?.path ?? join(dirname(importerRel), gap.specifier);
    if (moduleRel.startsWith("..")) return undefined;
    const base = readModule(baseCwd, moduleRel);
    const head = readModule(headCwd, moduleRel);
    if (base === undefined || head === undefined) return undefined;
    if (/export\s*\*\s*from/.test(base.text) || declaresExport(base.text, gap.name)) return undefined;
    if (!declaresExport(head.text, gap.name)) return undefined;
    named.push(`${gap.name} (${base.path})`);
  }
  return `base lacks export(s) ${named.join(", ")} that the PR adds — the test cannot link there, a genuine miss`;
  } catch {
    // Unreadable/invalid package or source bytes are not absence or a measured export gap.
    return undefined;
  }
}
