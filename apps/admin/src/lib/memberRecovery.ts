/**
 * Where member-facing password recovery lives.
 *
 * Recovery is a member experience and belongs on the studio's own public domain, not on the
 * staff desk domain. This value is configurable so a second white-label deployment points
 * at its own site without a code change; the fallback is the studio site this desk serves.
 */
export const MEMBER_RECOVERY_ORIGIN =
  process.env.NEXT_PUBLIC_MEMBER_RECOVERY_ORIGIN?.trim() || "https://www.arestrainingclub.com";
