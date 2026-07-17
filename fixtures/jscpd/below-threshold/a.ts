// FIXTURE (W1-T25) — distinct from b.ts in this same directory; duplication
// here is 0%, well under any sane threshold. test/jscpd-gate.test.ts asserts
// jscpd exits zero here. Never imported by src/ or test/ code; excluded from
// the repo-wide scan by .jscpd.json's ignore list.
export function sumInvoiceLineItems(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

export function applyPercentDiscount(amount: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new RangeError(`percent out of range: ${percent}`);
  }
  return amount * (1 - percent / 100);
}
