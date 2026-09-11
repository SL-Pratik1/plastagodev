import type { Place } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { placeRepository } from './place.repository.js';

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
      throw AppError.validation('That suburb is not one we service', [
        {
          path: 'placeId',
          message: 'Choose a suburb from the list — PlastaGo services Sydney, Wollongong and Newcastle',
        },
      ]);
    }

    return place;
  },
};
