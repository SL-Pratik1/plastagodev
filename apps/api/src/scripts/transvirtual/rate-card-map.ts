import { DEFAULT_RATE_CARD_ID } from '@plastago/shared';

/**
 * TransVirtual's 8 customer rate cards → this system's rate card ids.
 *
 * ⚠️ These ids already exist. `packages/shared/src/schemas/party.ts`'s
 * `SEEDED_RATE_CARDS` was written FROM this same TransVirtual data —
 * `clarendon-domaine` and `wisdom` are literally the two TransVirtual-derived
 * per-customer cards ("Clarendon and Domaine", "Wisdom Properties Group Pty
 * Ltd"), and `tier-1`..`tier-4` correct TransVirtual's own "Teir" spelling.
 * Using anything other than these exact ids would create duplicate cards
 * alongside ones `seed-settings.ts` may already have installed.
 *
 * "Test Customer" is deliberately absent — see `test-row-filter.ts`.
 *
 * Confirmed against the live TransVirtual "Customer Transport Rates" listing
 * during the read-only audit (2026-09-22).
 */
export const RATE_CARD_ID_MAP: Record<string, { id: string; label: string }> = {
  'clarendon and domaine': { id: 'clarendon-domaine', label: 'Clarendon & Domaine' },
  'default customer rates (default)': { id: DEFAULT_RATE_CARD_ID, label: 'Default Customer Rates' },
  'teir 1': { id: 'tier-1', label: 'Tier 1' },
  'teir 2': { id: 'tier-2', label: 'Tier 2' },
  'teir 3': { id: 'tier-3', label: 'Tier 3' },
  'teir 4': { id: 'tier-4', label: 'Tier 4' },
  'wisdom properties group pty ltd': { id: 'wisdom', label: 'Wisdom Properties Group' },
};

export function resolveRateCard(tvCardName: string): { id: string; label: string } | null {
  return RATE_CARD_ID_MAP[tvCardName.trim().toLowerCase()] ?? null;
}
