// jscpd falsifier fixture (W1-T97) -- the other half of the BELOW-threshold pair. Distinct logic
// from alpha.ts, no shared block of the size jscpd's default min-lines/min-tokens would flag.
export function summarizeUserProfile(user: { name: string; roles: string[] }): string {
  const roleList = user.roles.length > 0 ? user.roles.join(", ") : "no roles assigned";
  return `${user.name} (${roleList})`;
}

export function isEligibleForUpgrade(accountAgeDays: number, ticketsOpened: number): boolean {
  return accountAgeDays >= 30 && ticketsOpened < 3;
}
