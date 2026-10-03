/**
 * W1-T5519 — repair a task shard that two machine PRs from one base left holding a duplicated key.
 *
 * Twice on 2026-10-03 the machine-filing judge and the backlog gardener each added a `priority:` line to
 * one shard; git merged both, the shard stopped parsing, and #8877 and #8922 repaired it by hand: keep
 * the judge's `priority: 2.5`, drop the gardener's `priority: 4` and its `# backlog gardener:` marker.
 * The choice is not a judgement. The judge pins its ruling to the record (`risk_ruling.pin` =
 * {@link taskRulingPin}), so exactly one candidate is the record it judged. No pin, or a pin that
 * matches no candidate or several, is refused with its reason: a guess here would land unreviewed.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { parseTasksFromYaml } from "./plan.js";
import { taskRulingPin } from "./task-linter.js";

/** The `yaml` parser's words for a mapping that holds one key twice. */
export const DUPLICATE_KEY_ERROR_RE = /Map keys must be unique/;

export type ShardRepair =
  | { repaired: true; text: string; kept: Record<string, string> }
  | { refused: true; reason: string };

/** A shard quarantine error that this module can repair; anything else stays a hand repair. */
export function isDuplicateKeyError(error: string | undefined): boolean {
  return DUPLICATE_KEY_ERROR_RE.test(error ?? "");
}

/** Git's blob id for `text` — the per-bytes identity a repair is opened once for. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const TOP_LEVEL_KEY = /^(?:- | {2})([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const MAX_CANDIDATES = 16;

interface KeyLine {
  index: number;
  key: string;
  value: string;
}

function refuse(reason: string): ShardRepair {
  return { refused: true, reason };
}

/** A one-line scalar: a value on the key's own line and no deeper-indented continuation under it. */
function isOneLineScalar(lines: readonly string[], k: KeyLine): boolean {
  const next = lines[k.index + 1] ?? "";
  return k.value !== "" && !/^[|>]/.test(k.value) && !/^ {3,}\S/.test(next) && !/^ {2}- /.test(next);
}

/** Every way of keeping one line per duplicated key. */
function choices(groups: readonly KeyLine[][]): KeyLine[][] {
  return groups.reduce<KeyLine[][]>((acc, group) => acc.flatMap((picked) => group.map((k) => [...picked, k])), [[]]);
}

/** The shard with every unkept duplicate dropped, and the gardener marker of a dropped gardener priority. */
function candidateText(lines: readonly string[], groups: readonly KeyLine[][], kept: readonly KeyLine[]): string {
  const keptIdx = new Set(kept.map((k) => k.index));
  const drop = new Set(groups.flat().filter((k) => !keptIdx.has(k.index)).map((k) => k.index));
  const keptPriority = kept.find((k) => k.key === "priority")?.value;
  for (const k of groups.flat()) {
    if (!drop.has(k.index) || k.key !== "priority" || k.value === keptPriority) continue;
    const marker = new RegExp(`^ {2}# backlog gardener: band=${k.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} evidence=[a-f0-9]{16}\\s*$`);
    lines.forEach((line, i) => {
      if (marker.test(line)) drop.add(i);
    });
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

type PinVerdict = "covers" | "uncovered" | "unpinned" | { unloadable: string };

/** What the record's own `risk_ruling.pin` says of candidate `text`; a candidate that does not load names its error. */
function pinVerdict(text: string): PinVerdict {
  let task;
  try {
    parseYaml(text, { uniqueKeys: true });
    task = parseTasksFromYaml(text, "plan-shard-repair")[0]!;
  } catch (e) {
    // Not the record the judge pinned; the error rides out so an all-unloadable refusal can name it.
    return { unloadable: String((e as Error)?.message ?? e).split("\n")[0]! };
  }
  const pin = task.risk_ruling?.pin;
  if (pin === undefined) return "unpinned";
  return pin === taskRulingPin(task) ? "covers" : "uncovered";
}

/**
 * Repair a one-task shard that fails to parse on a duplicated top-level key: keep the candidate whose
 * {@link taskRulingPin} equals the record's `risk_ruling.pin`, remove every other duplicate line (and a
 * dropped gardener priority's `# backlog gardener:` marker). Pure: text in, text or a reason out.
 */
export function repairDuplicateKeyShard(text: string): ShardRepair {
  try {
    parseYaml(text, { uniqueKeys: true });
    return refuse("the shard has no duplicate key — it parses");
  } catch (e) {
    // The parse failure is the case this repairs; any other error is refused by name below.
    const message = String((e as Error)?.message ?? e);
    if (!DUPLICATE_KEY_ERROR_RE.test(message)) return refuse(`not a duplicate key: ${message.split("\n")[0]}`);
  }
  const lines = text.split("\n");
  const entries = lines.filter((l) => l.startsWith("- ")).length;
  if (entries !== 1) return refuse(`the shard holds ${entries} task entries; only a one-task shard is repaired`);
  const byKey = new Map<string, KeyLine[]>();
  lines.forEach((line, index) => {
    const m = TOP_LEVEL_KEY.exec(line);
    if (m) byKey.set(m[1]!, [...(byKey.get(m[1]!) ?? []), { index, key: m[1]!, value: m[2]!.trim() }]);
  });
  const groups = [...byKey.values()].filter((g) => g.length > 1);
  if (groups.length === 0) return refuse("the duplicated key is not a top-level task key");
  const multiLine = groups.flat().find((k) => !isOneLineScalar(lines, k));
  if (multiLine) return refuse(`duplicated key \`${multiLine.key}\` (line ${multiLine.index + 1}) is not a one-line scalar`);
  const all = choices(groups);
  if (all.length > MAX_CANDIDATES) return refuse(`${all.length} candidates exceed the ${MAX_CANDIDATES} this repair weighs`);
  const covered: Array<{ text: string; kept: KeyLine[] }> = [];
  const verdicts: PinVerdict[] = [];
  for (const kept of all) {
    const candidate = candidateText(lines, groups, kept);
    const verdict = pinVerdict(candidate);
    verdicts.push(verdict);
    if (verdict === "covers") covered.push({ text: candidate, kept });
  }
  const keys = groups.map((g) => `\`${g[0]!.key}\``).join(", ");
  const unloadable = verdicts.filter((v): v is { unloadable: string } => typeof v === "object");
  if (unloadable.length === verdicts.length) return refuse(`no candidate value of ${keys} loads: ${unloadable[0]!.unloadable}`);
  if (!verdicts.some((v) => v === "covers" || v === "uncovered")) return refuse(`the record carries no risk_ruling pin, so no value of ${keys} is the judge's`);
  if (covered.length === 0) return refuse(`no candidate value of ${keys} matches the record's risk_ruling pin`);
  if (covered.length > 1) return refuse(`${covered.length} candidate values of ${keys} match the risk_ruling pin — choosing one would be a guess`);
  const only = covered[0]!;
  return { repaired: true, text: only.text, kept: Object.fromEntries(only.kept.map((k) => [k.key, k.value])) };
}
