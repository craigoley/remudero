export function pick(x: number): number {
  if (x > 0) {
    if (x > 10) {
      return 10;
    }
    return x;
  }
  return 0;
}
