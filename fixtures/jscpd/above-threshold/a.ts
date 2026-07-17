// FIXTURE (W1-T25) — deliberately duplicated with b.ts in this same
// directory, well above any sane duplication threshold when THIS directory
// alone is scanned. test/jscpd-gate.test.ts asserts jscpd exits non-zero
// here. Never imported by src/ or test/ code; excluded from the repo-wide
// scan by .jscpd.json's ignore list.
export function normalizeWidgetName(raw: string): string {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  const collapsed = lowered.replace(/\s+/g, " ");
  const noPunctuation = collapsed.replace(/[^a-z0-9 ]/g, "");
  const words = noPunctuation.split(" ").filter(Boolean);
  const capitalized = words.map((w) => w[0]?.toUpperCase() + w.slice(1));
  return capitalized.join(" ");
}

export function widgetNameIsValid(raw: string): boolean {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  const collapsed = lowered.replace(/\s+/g, " ");
  const noPunctuation = collapsed.replace(/[^a-z0-9 ]/g, "");
  const words = noPunctuation.split(" ").filter(Boolean);
  const capitalized = words.map((w) => w[0]?.toUpperCase() + w.slice(1));
  return capitalized.length > 0;
}
