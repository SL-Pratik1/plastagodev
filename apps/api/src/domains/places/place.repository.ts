import type { Place, PlaceWrite } from '@plastago/shared';
import { Types } from 'mongoose';
import { JobModel } from '../jobs/job.model.js';
import { ZONES_COLLECTION } from '../settings/settings.model.js';
import { PlaceModel } from './place.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why every read here is an aggregation ─────────────────────────────────
 * A `Place` carries `zoneLabel`, and the zone lives in another collection. The
 * alternative — return the id and let each caller name it — is what the web
 * would otherwise have to do, with a fetched label map on fifteen screens and a
 * loading state on every one of them. One `$lookup` against a collection of a
 * handful of rows costs less than that, and it is why the place picker needs no
 * zone query of its own.
 */

interface RawPlace {
  _id: Types.ObjectId;
  suburb: string;
  postcode: string;
  state: string;
  zoneId: Types.ObjectId;
  latitude: number;
  longitude: number;
  label: string;
  archived: boolean;
  zone?: { label: string };
}

/**
 * The zone join, shared by every read.
 *
 * `preserveNullAndEmptyArrays` so a place whose zone has somehow gone still
 * comes back — a suburb that cannot name its zone is a row somebody has to be
 * able to SEE in order to fix. Dropping it would make the broken row invisible
 * on the one screen that can repair it.
 */
const WITH_ZONE = [
  {
    $lookup: {
      from: ZONES_COLLECTION,
      localField: 'zoneId',
      foreignField: '_id',
      as: 'zone',
    },
  },
  { $unwind: { path: '$zone', preserveNullAndEmptyArrays: true } },
];

function toPlace(raw: RawPlace): Place {
  return {
    id: raw._id.toString(),
    suburb: raw.suburb,
    postcode: raw.postcode,
    state: raw.state,
    zoneId: raw.zoneId.toString(),
    zoneLabel: raw.zone?.label ?? 'Unknown zone',
    latitude: raw.latitude,
    longitude: raw.longitude,
    label: raw.label,
  };
}

/** What the picker shows — built here so two rows cannot disagree about it. */
function labelFor(place: { suburb: string; state: string; postcode: string }): string {
  return `${place.suburb} ${place.state} ${place.postcode}`;
}

/**
 * A type-ahead shows what fits on screen. More than this is a list nobody reads
 * to the bottom of, and it is cheaper to make the user type another letter.
 */
const SUGGESTION_LIMIT = 8;

export const placeRepository = {
  /**
   * Suburbs matching what has been typed so far.
   *
   * An empty query returns the first page rather than nothing, so the control
   * can open with something in it.
   *
   * ⚠️ EXCLUDES archived suburbs. This feeds the booking form and the
   * serviceability check, both of which are about NEW work — a suburb the
   * business has stopped going to must not be offered for a fresh pickup. The
   * two reads below answer the opposite question, and say so.
   */
  async search(query: string): Promise<Place[]> {
    const term = query.trim();

    /*
     * The suburb matches ANYWHERE in the name, not just at the front.
     *
     * Half the estates here are two words — "Oran Park", "Marsden Park",
     * "Box Hill" — and somebody typing "park" means the second word as often as
     * the first. The postcode is anchored, because a postcode is read left to
     * right and a contains-match on digits produces nonsense.
     *
     * A leading wildcard cannot use the index. That is a deliberate trade: this
     * table is a few dozen suburbs, and a collection scan over it costs less
     * than the suggestions a stricter match would miss.
     */
    const match: Record<string, unknown> = { archived: false };
    if (term !== '') {
      match.$or = [
        { suburb: { $regex: escapeRegex(term), $options: 'i' } },
        { postcode: { $regex: `^${escapeRegex(term)}` } },
      ];
    }

    const rows = await PlaceModel.aggregate<RawPlace>([
      { $match: match },
      { $sort: { suburb: 1 } },
      ...WITH_ZONE,
    ]);

    const needle = term.toLowerCase();
    return rows
      .sort((a, b) => {
        // A prefix match is what the typist meant; a mid-word match is a maybe.
        const aStarts = a.suburb.toLowerCase().startsWith(needle);
        const bStarts = b.suburb.toLowerCase().startsWith(needle);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.suburb.localeCompare(b.suburb);
      })
      .slice(0, SUGGESTION_LIMIT)
      .map(toPlace);
  },

  /**
   * Every suburb, archived included, for the Suburbs admin screen.
   *
   * Unpaged on purpose: this is the list of places one business collects from,
   * and it will be hundreds of rows at most. A page control here would be
   * scaffolding around a list that fits in a scroll.
   */
  async list(): Promise<Place[]> {
    const rows = await PlaceModel.aggregate<RawPlace>([
      { $sort: { suburb: 1, postcode: 1 } },
      ...WITH_ZONE,
    ]);
    return rows.map(toPlace);
  },

  /**
   * One place by the id the form chose.
   *
   * Returns null for an unknown id rather than a nearby fallback: see the
   * warning on the model. "We do not go there" is a real answer.
   */
  async findById(id: string): Promise<Place | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const [row] = await PlaceModel.aggregate<RawPlace>([
      { $match: { _id: new Types.ObjectId(id) } },
      ...WITH_ZONE,
    ]);
    return row ? toPlace(row) : null;
  },

  /** Whether a place is off the picker. The booking gate refuses one. */
  async isArchived(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const row = await PlaceModel.findById(new Types.ObjectId(id), { archived: 1 }).lean<{
      archived: boolean;
    }>();
    return row?.archived ?? false;
  },

  /**
   * The place a job was booked into, found from what the job kept.
   *
   * ⚠️ A job stores `suburb`, `postcode` and the frozen `zoneId` — never the
   * place id it was picked from. That is right for the job (the zone must not
   * move when a suburb is re-zoned) but it means anything rebuilding a booking
   * from an existing job — rebooking a futile pickup, say — has to find the
   * place again, and the id is not derivable from the suburb with any rule that
   * survives "Lot 1" or a renamed estate.
   *
   * Matched on both fields because suburb names repeat across postcodes.
   *
   * ⚠️ INCLUDES archived suburbs, unlike `search` above. This rebuilds a booking
   * for work that genuinely happened, and a business that has since left a
   * suburb must still be able to rebook the pickup it already failed at.
   * Returns null when the suburb was never in the table at all, which is a real
   * answer: the caller must not quietly book into somewhere we do not go.
   */
  async findBySuburb(suburb: string, postcode: string): Promise<Place | null> {
    const [row] = await PlaceModel.aggregate<RawPlace>([
      {
        $match: {
          suburb: new RegExp(`^${escapeRegex(suburb.trim())}$`, 'i'),
          postcode: postcode.trim(),
        },
      },
      ...WITH_ZONE,
    ]);

    return row ? toPlace(row) : null;
  },

  async create(draft: PlaceWrite): Promise<Place> {
    const created = await PlaceModel.create({
      ...draft,
      label: labelFor(draft),
      zoneId: new Types.ObjectId(draft.zoneId),
      archived: false,
    });

    const place = await this.findById(created._id.toString());
    if (!place) throw new Error('place vanished immediately after it was created');
    return place;
  },

  async update(id: string, draft: PlaceWrite): Promise<void> {
    await PlaceModel.updateOne(
      { _id: new Types.ObjectId(id) },
      {
        $set: {
          ...draft,
          label: labelFor(draft),
          zoneId: new Types.ObjectId(draft.zoneId),
        },
      },
    );
  },

  async remove(id: string): Promise<void> {
    await PlaceModel.deleteOne({ _id: new Types.ObjectId(id) });
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    await PlaceModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: { archived } });
  },

  /**
   * How much work stands behind a suburb.
   *
   * ⚠️ Counted on SUBURB AND POSTCODE, never on a place id. A job stores the
   * suburb it was booked into and never the place it was picked from (see
   * `findBySuburb`), so a count by place id would return zero for every suburb
   * in the table and this guard would never fire once.
   */
  async countJobsIn(suburb: string, postcode: string): Promise<number> {
    return JobModel.countDocuments({
      suburb: new RegExp(`^${escapeRegex(suburb.trim())}$`, 'i'),
      postcode: postcode.trim(),
    });
  },

  /** Seeds the serviceable suburbs. Idempotent, so it is safe on every deploy. */
  async seed(
    places: Array<{
      suburb: string;
      postcode: string;
      state: string;
      zoneId: string;
      latitude: number;
      longitude: number;
    }>,
  ): Promise<void> {
    await Promise.all(
      places.map((place) =>
        PlaceModel.updateOne(
          /*
           * Keyed on what IDENTIFIES a suburb, not on an id: the `_id` is minted
           * by Mongo on first insert and has to survive a re-seed.
           */
          { suburb: place.suburb, postcode: place.postcode },
          {
            $set: {
              state: place.state,
              zoneId: new Types.ObjectId(place.zoneId),
              latitude: place.latitude,
              longitude: place.longitude,
              label: labelFor(place),
            },
            // The seed installs a suburb; it does not un-retire one the office
            // has since taken off the picker.
            $setOnInsert: { archived: false },
          },
          { upsert: true },
        ),
      ),
    );
  },

  async count(): Promise<number> {
    return PlaceModel.countDocuments();
  },
};

/**
 * User input goes into a regex, so it is escaped.
 *
 * Without this a typed `(` is a syntax error and a typed `.*` is a scan — the
 * mild end of the same class of bug as an injected query.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
