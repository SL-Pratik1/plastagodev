import { DRIVER_LIST_DEFAULTS, optionLabel, type DriverLists } from '@plastago/shared';

/**
 * The wording of a stored "can't collect" reason (Matt, 21 Oct).
 *
 * Jobs keep the reason's key; the list in Settings holds its wording, switched
 * off or not. Until the lists load, the built-in ones answer — every key a job
 * could have carried before the list was editable is among them.
 */
export function reasonLabel(lists: DriverLists | undefined, key: string): string {
  return optionLabel((lists ?? DRIVER_LIST_DEFAULTS).cantCollectReasons, key) ?? key;
}
