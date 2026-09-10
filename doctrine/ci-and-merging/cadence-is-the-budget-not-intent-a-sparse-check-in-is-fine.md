- **CADENCE IS THE BUDGET, NOT INTENT — a sparse check-in is fine, a poll is not. NOW ENFORCED:**
  `hooks/deny-floor.sh` rule 9 refuses a read-shaped `gh` call inside 180s of the last; writes and
  `gh api rate_limit` are exempt, and a deliberate burst is `RMD_GH_COOLDOWN_S=0` INLINE IN THE
  COMMAND (a hook is spawned by the harness, so an env-only override reaches nothing). The limit
  that bites is the SECONDARY one, counting RATE NOT VOLUME — it 403s while rate_limit reads
  5000/5000, so a quota check cannot predict it. *(80-call lockout 2026-08-20; a later session
  tripped it twice with no loop at all; enforced by W1-T3275 2026-09-09)*
