import { Schema, model } from 'mongoose';

export const PLACES_COLLECTION = 'places';

/**
 * A serviceable suburb (M2.1, Matt 7:25).
 *
 * ── Why this is a table and not a geocoder call ───────────────────────────
 * The suburb carries two things nothing else can supply: the ZONE that prices
 * the job (M6.3), and the pin that plots it on the dispatch board. Neither can
 * be guessed from typed text, which is why the booking form PICKS a suburb
 * rather than typing one — a job priced at Sydney rates because somebody typed
 * "Sydney" into a Wollongong address is not a bug anyone notices until the
 * month-end reconciliation.
 *
 * ⚠️ Absence is a real answer. PlastaGo services three zones, and a suburb that
 * is not in here means "we do not go there" — which the form has to be able to
 * say. It must never fall back to a nearby zone.
 *
 * The `_id` is an ordinary ObjectId. It was a slug of the suburb alone, which
 * cannot be unique: suburb names repeat across postcodes, so "Richmond" could
 * only ever be one of them. The row is IDENTIFIED by `{suburb, postcode}` — see
 * the unique index below — and keyed by an opaque id, which is also what lets it
 * become a Google place id later without touching a consumer.
 */
const placeSchema = new Schema(
  {
    suburb: { type: String, required: true, trim: true },
    postcode: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true, default: 'NSW' },
    /**
     * Decides the rate — REFERENCE → `zones._id`. See the warning above.
     *
     * ⚠️ No `enum`: zones are records an administrator creates, so `placeService`
     * checks the id exists because Mongo will not. Changing it re-zones the
     * suburb for the NEXT booking only; jobs froze their own zone.
     */
    zoneId: { type: Schema.Types.ObjectId, required: true, ref: 'Zone' },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    /** What the picker shows — "Kellyville NSW 2155". */
    label: { type: String, required: true, trim: true },

    /**
     * Taken off the picker, but not deleted.
     *
     * ⚠️ Three reads want three different answers here, and getting one wrong is
     * silent — each is commented at its own call site in `place.repository`:
     * the type-ahead EXCLUDES archived (it is about new work), the booking gate
     * REFUSES archived, and `findBySuburb` INCLUDES it, because rebooking a
     * futile pickup in a suburb the business has since left must still resolve.
     */
    archived: { type: Boolean, required: true, default: false },
  },
  { collection: PLACES_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * The type-ahead matches on suburb OR postcode, because the office has both to
 * hand — a supervisor says "Kellyville", a PO says "2155".
 */
placeSchema.index({ suburb: 1 }, { name: 'suburb' });
placeSchema.index({ postcode: 1 }, { name: 'postcode' });
placeSchema.index({ zoneId: 1 }, { name: 'zone' });

/**
 * A suburb is one row per postcode.
 *
 * ⚠️ This is what the old slug `_id` was standing in for, badly: `richmond`
 * could be NSW 2753 or VIC 3121, and the second one to be added silently lost.
 * Collation-free because both fields are stored trimmed and the postcode is
 * digits — but the suburb IS case-sensitive here, so the service normalises
 * before it writes rather than relying on the index to catch "kellyville".
 */
placeSchema.index({ suburb: 1, postcode: 1 }, { unique: true, name: 'suburb_postcode_unique' });

export const PlaceModel = model('Place', placeSchema);
