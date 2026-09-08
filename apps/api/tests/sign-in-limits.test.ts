import { describe, expect, it } from 'vitest';
import { signInLimits } from '../src/config/env.js';

/**
 * The sign-in rate ceilings (§9).
 *
 * ── Why a test for three numbers ──────────────────────────────────────────
 * Both directions have already gone wrong once, and they fail in opposite ways
 * that neither typecheck nor lint can see:
 *
 *  - too tight in development, and the app locks its own developer out after
 *    about two minutes of testing, with a message that reads like a bug;
 *  - too loose in production, and an unauthenticated endpoint that spends money
 *    on SMS is standing open.
 *
 * So the numbers are asserted rather than left to a ternary. If somebody widens
 * production to make their local testing easier, this fails and says why.
 */

describe('production limits', () => {
  const limits = signInLimits(false);

  it('caps one identifier at six codes an hour', () => {
    // Every code costs an SMS, and somebody genuinely signing in needs one or
    // two. Per IDENTIFIER, so a handful of proxies does not defeat it.
    expect(limits.sendsPerHourPerIdentifier).toBe(6);
  });

  it('caps sends per IP at an office-sized ceiling', () => {
    // The office is behind one NAT address, so this is per-office rather than
    // per-person: loose enough for a Monday morning, tight enough to matter.
    expect(limits.sendsPerIp).toBe(20);
  });

  it('is looser on verification than on sending', () => {
    /*
     * A mistyped code is the normal case and costs nothing; the per-challenge
     * attempt counter is the real guard against guessing. Sending is what
     * spends money, so it must always be the tighter of the two.
     */
    expect(limits.verifiesPerIp).toBeGreaterThan(limits.sendsPerIp);
  });

  it('never lets production inherit a development ceiling', () => {
    const development = signInLimits(true);

    // The regression that matters: somebody raising the limits to unblock their
    // own testing and raising both branches by accident.
    expect(limits.sendsPerHourPerIdentifier).toBeLessThan(
      development.sendsPerHourPerIdentifier,
    );
    expect(limits.sendsPerIp).toBeLessThan(development.sendsPerIp);
  });
});

describe('development limits', () => {
  const limits = signInLimits(true);

  it('survives a long testing session', () => {
    /*
     * The bug this replaced: six codes an hour meant signing in and out to check
     * a screen locked the developer out of their own app for an hour. A working
     * afternoon is well over a hundred sign-ins.
     */
    expect(limits.sendsPerHourPerIdentifier).toBeGreaterThanOrEqual(100);
  });

  it('does not trip the per-IP limiter either', () => {
    // A developer and their browser share one address, so the IP ceiling has to
    // clear the per-identifier one — otherwise raising that alone changes
    // nothing, which is exactly how the first fix would have failed.
    expect(limits.sendsPerIp).toBeGreaterThan(limits.sendsPerHourPerIdentifier);
    expect(limits.verifiesPerIp).toBeGreaterThan(limits.sendsPerHourPerIdentifier);
  });
});
