import type { LocatedPlaceWrite, Place, PlaceWrite, Role } from '@plastago/shared';
import { getMapsProvider } from '../../integrations/maps.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { placeRepository } from './place.repository.js';

const log = logger.child({ module: 'places' });

/** Who is asking. Declared per domain, as every other service here does. */
export interface Caller {
  roles: readonly Role[];
  accountId: string | null;
}

/**
 * Serviceable suburbs (M2.1, Matt 7:25).
 *
 * ── Why resolution lives on the server ────────────────────────────────────
 * The booking form sends a `placeId` and nothing else about the address's
 * geography. It could send the zone and the coordinate directly — and then a
 * caller could nominate its own, and the zone decides the price (M6.3). A job
 * priced at Sydney rates because somebody edited a hidden field is not a bug
 * anyone notices until the month-end reconciliation.
 */
export const placeService = {
  async search(query: string): Promise<Place[]> {
    return placeRepository.search(query);
  },

  /**
   * The place a job was booked into, from the suburb and postcode it kept.
   *
   * For rebuilding a booking out of an existing job — a job stores the suburb
   * and the frozen zone, never the `placeId` it was picked from. Null when the
   * suburb is no longer served; the caller decides what that means.
   */
  async findForJob(suburb: string, postcode: string): Promise<Place | null> {
    return placeRepository.findBySuburb(suburb, postcode);
  },

  /**
   * The place behind a chosen id, for anything that must not proceed without it.
   *
   * Throws rather than returning null so no caller can accidentally continue
   * with a job that has no zone. "We do not go there" is a real answer, and it
   * is a 422 against the field the user actually chose.
   */
  async require(placeId: string): Promise<Place> {
    const place = await placeRepository.findById(placeId);

    if (!place) {
      /*
       * ⚠️ The message used to name the three zones. It cannot: an
       * administrator adds zones now, so prose listing them would be wrong the
       * first time somebody used the feature — and wrong in a string, where no
       * typecheck would ever find it.
       */
      throw AppError.validation('That suburb is not one we service', [
        { path: 'placeId', message: 'Choose a suburb from the list' },
      ]);
    }

    /*
     * ⚠️ A retired suburb is REFUSED here, and only here.
     *
     * This is the booking gate. `search` already keeps archived suburbs out of
     * the picker, but a stale tab or a replayed request can still carry one —
     * and booking into a suburb the business has left produces a job no future
     * schedule will price. `findBySuburb`, by contrast, deliberately still
     * finds it, because rebooking work that already happened must keep working.
     */
    if (await placeRepository.isArchived(placeId)) {
      throw AppError.validation('That suburb is not one we service', [
        { path: 'placeId', message: 'We no longer collect from there — choose another suburb' },
      ]);
    }

    return place;
  },

  /* ── Administration (M6.3) ─────────────────────────────────────────────── */

  /** Every suburb, archived included — the admin screen has to show both. */
  async list(caller: Caller): Promise<Place[]> {
    assertPlaceWriter(caller);
    return placeRepository.list();
  },

  async create(input: PlaceWrite, caller: Caller): Promise<Place> {
    assertPlaceWriter(caller);
    await assertZoneExists(input.zoneId);

    const existing = await placeRepository.findBySuburb(input.suburb, input.postcode);
    if (existing) {
      // 409, not 422: the request is well formed, it just names a row that is
      // already there. Same reading as a duplicate rate card.
      throw AppError.conflict(`${input.suburb} ${input.postcode} is already in the picker`);
    }

    const place = await placeRepository.create(await locate(input));
    log.info({ placeId: place.id, zoneId: input.zoneId }, 'suburb added');
    return place;
  },

  /**
   * Edit a suburb, including which zone it is in.
   *
   * ⚠️ RE-ZONING IS THE POINT. A newly added zone is unreachable until a suburb
   * points at it, so this is the other half of "add a zone" — and it is the way
   * out of the refusal that blocks retiring a zone with suburbs still in it.
   *
   * ⚠️ It changes NOTHING about work already booked. A job froze its `zoneId`
   * and its whole `appliedRate` when it was priced, so moving Dapto from
   * Wollongong to a new South Coast zone reprices the next booking and never a
   * job on the board — let alone one already invoiced. That freeze is what makes
   * this safe to expose at all.
   */
  async update(id: string, input: PlaceWrite, caller: Caller): Promise<Place> {
    assertPlaceWriter(caller);
    await requirePlace(id);
    await assertZoneExists(input.zoneId);

    const clash = await placeRepository.findBySuburb(input.suburb, input.postcode);
    if (clash && clash.id !== id) {
      throw AppError.conflict(`${input.suburb} ${input.postcode} is already in the picker`);
    }

    await placeRepository.update(id, await locate(input));
    log.info({ placeId: id, zoneId: input.zoneId }, 'suburb updated');
    return requirePlace(id);
  },

  /**
   * Take a suburb off the picker.
   *
   * ── Two outcomes behind one verb, and why ─────────────────────────────────
   * A suburb nobody has ever collected from is a typo — "Kellyvile" — and the
   * office means REMOVE IT. A suburb with jobs behind it is a place the business
   * has stopped going to, and deleting the row would leave those jobs naming a
   * suburb the system no longer knows: `findBySuburb` is how a futile pickup is
   * rebooked, and it would return null on work that genuinely happened.
   *
   * Returns the archived place, or null when it was really deleted, so the
   * screen can show what happened instead of assuming a removal.
   */
  async remove(id: string, caller: Caller): Promise<Place | null> {
    assertPlaceWriter(caller);
    const place = await requirePlace(id);

    const jobs = await placeRepository.countJobsIn(place.suburb, place.postcode);
    if (jobs === 0) {
      await placeRepository.remove(id);
      log.info({ placeId: id }, 'suburb removed — nothing had ever been collected from it');
      return null;
    }

    await placeRepository.setArchived(id, true);
    log.info({ placeId: id, jobs }, 'suburb retired — the jobs behind it keep their address');
    return requirePlace(id);
  },

  /** Put a retired suburb back on the picker. */
  async restore(id: string, caller: Caller): Promise<Place> {
    assertPlaceWriter(caller);
    await requirePlace(id);
    await placeRepository.setArchived(id, false);
    log.info({ placeId: id }, 'suburb restored');
    return requirePlace(id);
  },
};

/**
 * Writing this table is a statement about where the business goes.
 *
 * ⚠️ Looser than zone administration, on purpose. Adding a suburb is an
 * operational fact — "we now collect from Gregory Hills" — that writes no money
 * row. Adding a ZONE writes a rate row on every card for every schedule they
 * have ever had, which is why that one is super-admin alone. Two blast radii,
 * two gates.
 */
const PLACE_WRITERS = new Set<Role>(['super-admin', 'operations']);

function assertPlaceWriter(caller: Caller): void {
  if (!caller.roles.some((role) => PLACE_WRITERS.has(role))) {
    throw AppError.forbidden('Your role does not allow that');
  }
}

async function requirePlace(id: string): Promise<Place> {
  const place = await placeRepository.findById(id);
  if (!place) throw AppError.notFound(`No suburb is configured for "${id}"`);
  return place;
}

/**
 * Fill in the pin, so an administrator never types a coordinate (I3).
 *
 * ── Why the form stopped asking ───────────────────────────────────────────
 * It asked for a latitude and a longitude, and nobody adding "we now collect
 * from Gregory Hills" knows either. The pin is not optional — it is what puts
 * every job in that suburb on the dispatch map, and what a geocoded street
 * address is distance-checked against (see `resolveLocation` in the jobs
 * service) — so the answer is to LOOK IT UP, not to drop it.
 *
 * ── Why a typed pin still wins ────────────────────────────────────────────
 * A supplied coordinate is used as given and Google is not called. That is the
 * correction path: this screen is the only place a wrong pin can be fixed, and
 * a lookup that silently overrode the fix would make the fix impossible.
 *
 * ── Why the failure is a 422 and not a fallback ───────────────────────────
 * Every other maps call here falls back to something correct — the suburb
 * centroid, the allocator's own ordering. There is nothing to fall back TO for
 * a suburb that has no pin at all, and inventing one (the postcode's centre,
 * the zone's other suburbs) would put jobs somewhere plausible and wrong. So it
 * refuses, names the reason, and the screen reveals the two fields.
 */
async function locate(input: PlaceWrite): Promise<LocatedPlaceWrite> {
  if (input.latitude !== undefined && input.longitude !== undefined) {
    return { ...input, latitude: input.latitude, longitude: input.longitude };
  }

  const pin = await getMapsProvider().geocodeSuburb({
    suburb: input.suburb,
    postcode: input.postcode,
    state: input.state,
  });

  if (!pin) {
    log.warn(
      { suburb: input.suburb, postcode: input.postcode, provider: getMapsProvider().name },
      'could not locate the suburb — asking for the pin instead',
    );
    throw AppError.validation(`We could not find ${input.suburb} ${input.postcode} on the map`, [
      {
        path: 'latitude',
        message: 'Enter the pin by hand — right-click the suburb in Google Maps to read it off',
      },
    ]);
  }

  log.info({ suburb: input.suburb, matched: pin.formattedAddress }, 'suburb located');
  return { ...input, latitude: pin.latitude, longitude: pin.longitude };
}

/**
 * The zone exists.
 *
 * ⚠️ This is one of the guards that REPLACED `enum: ZONES` on the model. Mongo
 * used to refuse an unknown zone; it no longer can, so a typo would save
 * cleanly and the suburb would price nothing — visible only as a 503 on a
 * booking form, weeks later.
 */
async function assertZoneExists(zoneId: string): Promise<void> {
  const zone = await settingsRepository.findZone(zoneId);
  if (!zone) {
    throw AppError.validation('That is not a zone', [
      { path: 'zoneId', message: 'Choose one of the zones from the list' },
    ]);
  }
  if (zone.archived) {
    throw AppError.validation('That zone has been retired', [
      { path: 'zoneId', message: `${zone.label} is no longer offered — choose another zone` },
    ]);
  }
}
