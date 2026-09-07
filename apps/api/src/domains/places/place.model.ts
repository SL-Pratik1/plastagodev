import { ZONES } from '@plastago/shared';
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
 * The `_id` is the suburb slug today and can become a Google place id later
 * without touching anything that references it, because every consumer treats
 * it as opaque.
 */
const placeSchema = new Schema(
  {
    _id: { type: String },
    suburb: { type: String, required: true, trim: true },
    postcode: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true, default: 'NSW' },
    /** Decides the rate. See the warning above. */
    zone: { type: String, required: true, enum: ZONES },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    /** What the picker shows — "Kellyville NSW 2155". */
    label: { type: String, required: true, trim: true },
  },
  { collection: PLACES_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

/**
 * The type-ahead matches on suburb OR postcode, because the office has both to
 * hand — a supervisor says "Kellyville", a PO says "2155".
 */
placeSchema.index({ suburb: 1 }, { name: 'suburb' });
placeSchema.index({ postcode: 1 }, { name: 'postcode' });
placeSchema.index({ zone: 1 }, { name: 'zone' });

export const PlaceModel = model('Place', placeSchema);
