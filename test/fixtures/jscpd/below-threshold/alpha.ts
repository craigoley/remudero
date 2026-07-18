// jscpd falsifier fixture (W1-T97) -- BELOW-threshold half. No block here is duplicated anywhere
// in this fixture pair -- this proves the gate does NOT false-positive on distinct code.
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
