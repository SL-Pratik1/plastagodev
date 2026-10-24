/**
 * M4.5 — their photo protocol, as data.
 *
 * Matt described it as a prompt rather than a fixed form: *"a prompt of what's
 * in the photos that are required, and a space to put in any others"*. Sent to
 * the phone so the app renders the checklist without hard-coding it, and so
 * changing the protocol later is a server change rather than an app release.
 *
 * "Cars on site" is the conditional one — it only applies where the driver could
 * not close the site, which is exactly the case that gets disputed.
 *
 * Also read by invoicing: a job is not billed automatically until every
 * required shot is in (21 Oct).
 */
export const REQUIRED_PHOTOS = [
  {
    key: 'front-of-site',
    label: 'Front of site',
    hint: 'Wide shot from the street, showing the lot number if you can',
    required: true,
  },
  {
    key: 'pile-before',
    label: 'Pile before',
    hint: 'The whole stack before you start loading',
    required: true,
  },
  {
    key: 'pile-after',
    label: 'Pile after',
    hint: 'The same spot once the load is on the truck',
    required: true,
  },
  {
    key: 'site-closed',
    label: 'Site closed',
    hint: 'Gates shut and the site left as you found it',
    required: true,
  },
  {
    key: 'cars-on-site',
    label: 'Cars on site',
    hint: 'Only if you could not close the site — shows why',
    required: false,
  },
] as const;
