import type { Driver } from '@plastago/shared';
import mongoose from 'mongoose';
import { UserModel } from '../auth/auth.model.js';

/**
 * Drivers, as dispatch sees them.
 *
 * ── Why this reads the users collection rather than owning one ────────────
 * A driver IS a user — they sign in to the driver app with the same identity
 * the office uses (§9). Giving dispatch its own driver table would mean two
 * records for one person that could disagree about their name or whether they
 * still work here.
 *
 * ⚠️ Four fields on the `Driver` contract belong to domains that do not exist
 * yet: `vehicleRego` and `vehicleLabel` come from fleet (M9), and `lastSyncAt`
 * and `pendingSyncActions` from the driver app's sync log (§6A.8). They are
 * returned as null/0 until those land, rather than being invented — a made-up
 * sync time is worse than an obviously absent one, because somebody would trust
 * it. `dailyJobCapacity` is the documented default (M3.4) for the same reason.
 */

/** M3.4 — a simple capacity column, not a full availability dashboard. */
const DEFAULT_DAILY_CAPACITY = 8;

interface RawDriver {
  _id: mongoose.Types.ObjectId;
  name: string;
  phoneNumber: string | null;
  status: string;
}

function toDriver(row: RawDriver): Driver {
  return {
    id: row._id.toHexString(),
    name: row.name,
    // The contract says `mobile`; Better Auth's plugin owns `phoneNumber`. A
    // rename at the boundary, not a second copy of the number.
    mobile: row.phoneNumber ?? '',
    vehicleRego: null,
    vehicleLabel: null,
    // `off` for anyone not currently active, so a suspended driver cannot be
    // put on a run by accident. Dispatch overlays `on-run` from the board.
    status: row.status === 'active' ? 'available' : 'off',
    dailyJobCapacity: DEFAULT_DAILY_CAPACITY,
    nextComplianceExpiry: null,
    lastSyncAt: null,
    pendingSyncActions: 0,
  };
}

export const driverRepository = {
  /**
   * Everyone who can be put on a run.
   *
   * Includes inactive drivers, marked `off`, rather than hiding them: the board
   * shows who is not working today, and a driver who vanishes from the list
   * looks like a bug to whoever was expecting them.
   */
  async list(): Promise<Driver[]> {
    const rows = await UserModel.find({ roles: 'driver' })
      .sort({ name: 1 })
      .lean<RawDriver[]>();

    return rows.map(toDriver);
  },

  async findById(driverId: string): Promise<Driver | null> {
    if (!mongoose.isValidObjectId(driverId)) return null;

    // The role is part of the FILTER, so an office user's id cannot be assigned
    // to a run by pasting it into the driver field.
    const row = await UserModel.findOne({ _id: driverId, roles: 'driver' }).lean<RawDriver>();
    return row ? toDriver(row) : null;
  },
};
