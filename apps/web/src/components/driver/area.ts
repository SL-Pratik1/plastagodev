/**
 * A job's booked m², as the driver reads it.
 *
 * ⚠️ The run sheet sends 0 for a job that carries no area — a fixed-price order
 * (Wisdom's) names a price and no square metres — and "0 m²" reads as "nothing
 * to collect" to someone standing at the truck. The wire keeps sending a number
 * so the Flutter driver app's contract is untouched; only the words change.
 */
export function formatBookedArea(squareMetres: number): string {
  return squareMetres > 0 ? `${squareMetres.toLocaleString('en-AU')} m²` : 'm² not given';
}
