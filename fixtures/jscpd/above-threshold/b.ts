// FIXTURE (W1-T25) — deliberately duplicated with a.ts in this same
// directory (see a.ts header for why).
export function normalizeGadgetName(raw: string): string {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  const collapsed = lowered.replace(/\s+/g, " ");
  const noPunctuation = collapsed.replace(/[^a-z0-9 ]/g, "");
  const words = noPunctuation.split(" ").filter(Boolean);
  const capitalized = words.map((w) => w[0]?.toUpperCase() + w.slice(1));
  return capitalized.join(" ");
}

export function gadgetNameIsValid(raw: string): boolean {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  const collapsed = lowered.replace(/\s+/g, " ");
  const noPunctuation = collapsed.replace(/[^a-z0-9 ]/g, "");
  const words = noPunctuation.split(" ").filter(Boolean);
  const capitalized = words.map((w) => w[0]?.toUpperCase() + w.slice(1));
  return capitalized.length > 0;
}
