import { parse as parseYaml } from "yaml";

export interface PromisedFollowUp { path: string; text: string; taskId?: string }
export interface FollowUpPlanRecord { id: string; title: string; plan_refs?: readonly string[]; rationale?: string; prompt?: string }
export interface HarvestableFollowUp { type: "research" | "task" | "action"; text: string }

/** The worker harvest and review guard intentionally share this closed, existing report grammar. */
export function parseHarvestableFollowUps(text: string): HarvestableFollowUp[] | null {
  const section = text.match(/^[ \t]*##[ \t]*Follow-ups[ \t]*\n([\s\S]*?)(?=\n[ \t]*##[ \t]|(?![\s\S]))/im);
  if (!section) return null;
  const entries: HarvestableFollowUp[] = [];
  const lineRe = /^[ \t]*(?:[-*][ \t]*)?(research|task|action)[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
  for (const m of section[1]!.matchAll(lineRe)) {
    const value = m[2]!.trim();
    if (value) entries.push({ type: m[1]!.toLowerCase() as HarvestableFollowUp["type"], text: value });
  }
  return entries.length ? entries : null;
}

function promisedList(text: string): string[] {
  const out: string[] = [];
  let fence: { char: string; size: number } | undefined, indent: number | undefined;
  let bulletIndent: number | undefined, pending: string | undefined;
  const flush = () => { if (pending) out.push(pending.trim()); pending = undefined; bulletIndent = undefined; };
  for (const line of text.split(/\r?\n/)) {
    const fenced = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      const marker = fenced[1]!;
      if (!fence) { flush(); indent = undefined; fence = { char: marker[0]!, size: marker.length }; }
      else if (marker[0] === fence.char && marker.length >= fence.size) fence = undefined;
      continue;
    }
    if (fence) continue;
    const header = /^([ ]*)(?:[-*][ \t]+)?Follow-up tasks this record files:[ \t]*$/i.exec(line);
    if (header && header[1]!.length < 4) { flush(); indent = header[1]!.length; continue; }
    if (indent === undefined) continue;
    if (!line.trim()) continue;
    const bullet = /^([ ]*)(?:[-*+]|\d+[.)])[ \t]+(.+)$/.exec(line);
    if (bullet && bullet[1]!.length >= indent) {
      flush(); bulletIndent = bullet[1]!.length; pending = bullet[2]!.trim(); continue;
    }
    const leading = /^ */.exec(line)![0].length;
    if (pending && bulletIndent !== undefined && leading > bulletIndent && !/^\s*(?:#|>)/.test(line)) pending += " " + line.trim();
    else { flush(); indent = undefined; }
  }
  flush();
  return [...new Set(out)];
}

/** Read only changed ADRs or task designs. A read/parse failure is not an empty measurement. */
export function promisedFollowUps(files: readonly string[], readFile: (path: string) => string): PromisedFollowUp[] {
  const out: PromisedFollowUp[] = [];
  for (const path of [...new Set(files)]) {
    if (/^docs\/adr\/[^/]+\.md$/.test(path)) {
      out.push(...promisedList(readFile(path)).map(text => ({ path, text })));
    } else if (/^plan\/tasks(?:\.yaml|\.d\/[^/]+\.ya?ml)$/.test(path)) {
      const parsed: unknown = parseYaml(readFile(path));
      const records: unknown = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown } | null)?.tasks;
      if (!Array.isArray(records)) throw new Error(`promise task source is not a task list: ${path}`);
      for (const record of records as Array<{ id?: unknown; design?: unknown }>) {
        if (typeof record.design !== "string") continue;
        if (typeof record.id !== "string") throw new Error(`promise task has no id: ${path}`);
        out.push(...promisedList(record.design).map(text => ({ path, text, taskId: record.id as string })));
      }
    }
  }
  return out;
}

const normalized = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const namesPromise = (text: string, promise: string): boolean => {
  const name = normalized(promise);
  return name.length > 0 && (` ${normalized(text)} `).includes(` ${name} `);
};

/** Conservative literal naming, not a model or fuzzy similarity gate. Copying the named promise is sufficient. */
export function unreportedFollowUps(promised: readonly PromisedFollowUp[], report: string, records: readonly FollowUpPlanRecord[]): PromisedFollowUp[] {
  const entries = parseHarvestableFollowUps(report) ?? [];
  return promised.filter(promise => !entries.some(entry => namesPromise(entry.text, promise.text)) &&
    !records.some(record => promise.taskId !== undefined && record.plan_refs?.includes(promise.taskId) &&
      [record.title, record.rationale ?? "", record.prompt ?? ""].some(text => namesPromise(text, promise.text))));
}
