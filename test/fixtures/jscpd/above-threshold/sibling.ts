// jscpd falsifier fixture (W1-T97) -- the other half of the ABOVE-threshold pair. Verbatim copy
// of alpha.ts's function body under a different name -- exactly the kind of copy-paste jscpd
// exists to catch.
export function computeInvoiceTotal(items: { price: number; quantity: number }[]): number {
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
