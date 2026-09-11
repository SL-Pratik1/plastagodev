import type { Place } from '@plastago/shared';
import { PlaceModel } from './place.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

interface RawPlace {
  _id: string;
  suburb: string;
  postcode: string;
  state: string;
  zone: Place['zone'];
  latitude: number;
  longitude: number;
  label: string;
}

function toPlace(raw: RawPlace): Place {
  return {
    id: raw._id,
    suburb: raw.suburb,
    postcode: raw.postcode,
    state: raw.state,
    zone: raw.zone,
    latitude: raw.latitude,
    longitude: raw.longitude,
    label: raw.label,
  };
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
   * can open with something in it — with three zones the whole set is small
   * enough to browse.
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
     * table is the suburbs of three zones, and a collection scan over a few
     * dozen rows costs less than the suggestions a stricter match would miss.
     */
    const filter =
      term === ''
        ? {}
        : {
            $or: [
              { suburb: { $regex: escapeRegex(term), $options: 'i' } },
              { postcode: { $regex: `^${escapeRegex(term)}` } },
            ],
          };

    const rows = await PlaceModel.find(filter).sort({ suburb: 1 }).lean<RawPlace[]>();

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
   * One place by the id the form chose.
   *
   * Returns null for an unknown id rather than a nearby fallback: see the
   * warning on the model. "We do not go there" is a real answer.
   */
  async findById(id: string): Promise<Place | null> {
    const row = await PlaceModel.findById(id.trim().toLowerCase()).lean<RawPlace>();
    return row ? toPlace(row) : null;
  },

  /**
   * The place a job was booked into, found from what the job kept.
   *
   * ⚠️ A job stores `suburb`, `postcode` and the frozen `zone` — never the
   * `placeId` it was picked from. That is right for the job (the zone must not
   * move when a suburb is re-zoned) but it means anything rebuilding a booking
   * from an existing job — rebooking a futile pickup, say — has to find the
   * place again, and the id is not derivable from the suburb with any rule that
   * survives "Lot 1" or a renamed estate.
   *
   * Matched on both fields because suburb names repeat across postcodes.
   * Returns null when the suburb is no longer served, which is a real answer:
   * the caller must not quietly book into somewhere we do not go.
   */
  async findBySuburb(suburb: string, postcode: string): Promise<Place | null> {
    const row = await PlaceModel.findOne({
      suburb: new RegExp(`^${suburb.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      postcode: postcode.trim(),
    }).lean<RawPlace>();

    return row ? toPlace(row) : null;
  },

  /** Seeds the serviceable suburbs. Idempotent, so it is safe on every deploy. */
  async seed(places: Array<Omit<Place, 'label'>>): Promise<void> {
    await Promise.all(
      places.map((place) =>
        PlaceModel.updateOne(
          { _id: place.id },
          {
            $set: {
              suburb: place.suburb,
              postcode: place.postcode,
              state: place.state,
              zone: place.zone,
              latitude: place.latitude,
              longitude: place.longitude,
              label: `${place.suburb} ${place.state} ${place.postcode}`,
            },
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
