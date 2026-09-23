/**
 * Shared "is this TransVirtual row test/dummy data" predicate, applied the
 * same way across every entity. TransVirtual was seen during the read-only
 * audit to carry a rate card and a supplier literally named "Test Customer"/
 * "Test Agent" — real onboarding leftovers, not real business data.
 *
 * Deliberately a narrow prefix/exact match rather than a broad "contains
 * test" — a real business legitimately named something like "Test Equipment
 * Co" must not be silently dropped. Every exclusion is logged with the raw
 * row it matched, so a false positive is a five-second check against the
 * report, not a silent data loss.
 */
const TEST_ROW_PATTERN = /^(test|dummy|do not use|sample|demo)\b/i;

export function isLikelyTestRow(name: string): boolean {
  return TEST_ROW_PATTERN.test(name.trim());
}
