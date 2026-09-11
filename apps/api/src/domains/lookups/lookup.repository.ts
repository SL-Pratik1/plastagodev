import type mongoose from 'mongoose';
import { AccountModel } from '../accounts/account.model.js';
import { UserModel } from '../auth/auth.model.js';
import { JobModel } from '../jobs/job.model.js';
import { RateCardModel } from '../settings/settings.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why these are not just the domain lists ───────────────────────────────
 * A filter dropdown must not page through an entire domain to populate itself.
 * `GET /accounts?pageSize=500` would work and would also send every address,
 * contact and rate card to a browser that wanted two columns. Each query below
 * projects only the value and the label.
 */

export interface LookupRow {
  value: string;
  label: string;
}

export const lookupRepository = {
  /** Active accounts only — you cannot book against a suspended one anyway. */
  async accounts(): Promise<LookupRow[]> {
    // ⚠️ The field on the document is `code`; `customerCode` is only its name
    // in the API contract. Projecting the contract name returned undefined for
    // every row, so the dropdown read "iPlasta Pty Ltd (undefined)".
    const rows = await AccountModel.find({ status: 'active' }, { name: 1, code: 1 })
      .sort({ name: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId; name: string; code: string }>>();

    return rows.map((row) => ({
      value: row._id.toHexString(),
      // The code disambiguates the builders who trade under similar names.
      label: row.code ? `${row.name} (${row.code})` : row.name,
    }));
  },

  /**
   * Builder names, derived from the JOBS.
   *
   * ⚠️ Not from an account or a site register. The builder is a property of the
   * WORK, not of the payer (M1.2) — iPlasta is invoiced while GJ Gardner is the
   * builder on site — and the site register that used to carry it is gone
   * (Matt, 0:29). The name is now recorded on the job, so that is where the list
   * has to come from.
   *
   * The value is the NAME rather than an id, because there is no builder record
   * to have an id: this feeds a filter that matches on the string.
   */
  async builders(): Promise<LookupRow[]> {
    const names = await JobModel.aggregate<{ _id: string }>([
      { $match: { builderName: { $nin: [null, '', '—'] } } },
      { $group: { _id: '$builderName' } },
      { $sort: { _id: 1 } },
      // A dropdown longer than this is one nobody scrolls to the bottom of.
      { $limit: 200 },
    ]);

    return names.map((row) => ({ value: row._id, label: row._id }));
  },

  /**
   * Every driver, including inactive ones.
   *
   * Marked rather than hidden: a filter that silently drops a driver makes
   * their historical jobs unfindable, and "why can't I filter to Dave any more"
   * is a support call.
   */
  async drivers(): Promise<LookupRow[]> {
    const rows = await UserModel.find({ roles: 'driver' }, { name: 1, status: 1 })
      .sort({ name: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId; name: string; status: string }>>();

    return rows.map((row) => ({
      value: row._id.toHexString(),
      label: row.status === 'active' ? row.name : `${row.name} (inactive)`,
    }));
  },

  /**
   * M6.1 — every rate card, by id and name.
   *
   * ⚠️ The label comes from the RECORD, never from a lookup table. Cards are
   * added by an administrator now, so there is no compile-time map that could
   * name one — a screen that fell back to a hardcoded label would render blank
   * for exactly the cards somebody had just created.
   *
   * Sorted by label rather than by id so the list reads alphabetically to a
   * human, not `clarendon-domaine, default, tier-1`.
   */
  async rateCards(): Promise<LookupRow[]> {
    const rows = await RateCardModel.find({}, { label: 1 })
      .sort({ label: 1 })
      .lean<Array<{ _id: string; label: string }>>();

    return rows.map((row) => ({ value: row._id, label: row.label }));
  },
};
