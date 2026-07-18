// jscpd falsifier fixture (W1-T97) -- ABOVE-threshold half. This function body is copy-pasted
// verbatim into sibling.ts below: a real, non-contrived duplicate block big enough (>= jscpd's
// default min-lines/min-tokens) to be detected, and large relative to this tiny fixture pair so
// the duplicated-lines percentage clears any realistic threshold.
export function computeOrderTotal(items: { price: number; quantity: number }[]): number {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.quantity;
  }
  let discount = 0;
  if (subtotal > 100) {
    discount = subtotal * 0.1;
  } else if (subtotal > 50) {
    discount = subtotal * 0.05;
  }
  const taxable = subtotal - discount;
  const tax = taxable * 0.0825;
  const total = taxable + tax;
  return Math.round(total * 100) / 100;
}
