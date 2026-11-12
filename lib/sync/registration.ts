// A notification registration lasts as long as the credential it was last
// authorized with (ten minutes by default), so reauthorize well before then.
const RENEWAL_LEAD_MS = 2 * 60 * 1000;

export const REGISTRATION_RETRY_MS = 5 * 60 * 1000;

export function registrationRenewalDelay(
  expiresAt: string,
  now = Date.now(),
): number {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return 0;
  // Short-lived credentials renew halfway through, rather than immediately.
  return Math.max(0, remaining - Math.min(RENEWAL_LEAD_MS, remaining / 2));
}
