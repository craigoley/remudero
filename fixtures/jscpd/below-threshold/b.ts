// FIXTURE (W1-T25) — distinct from a.ts in this same directory (see a.ts
// header for why).
export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (word.endsWith("y")) return `${word.slice(0, -1)}ies`;
  if (word.endsWith("s")) return `${word}es`;
  return `${word}s`;
}

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
