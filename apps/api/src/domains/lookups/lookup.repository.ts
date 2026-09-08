import type mongoose from 'mongoose';
import { AccountModel } from '../accounts/account.model.js';
import { UserModel } from '../auth/auth.model.js';
import { JobModel } from '../jobs/job.model.js';

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
    const rows = await AccountModel.find(
      { status: 'active' },
      { name: 1, customerCode: 1 },
    )
      .sort({ name: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId; name: string; customerCode: string }>>();

    return rows.map((row) => ({
      value: row._id.toHexString(),
      // The code disambiguates the builders who trade under similar names.
      label: `${row.name} (${row.customerCode})`,
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
};
