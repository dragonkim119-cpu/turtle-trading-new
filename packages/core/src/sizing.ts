/**
 * 2% rule position sizing.
 * qty = (equity * riskPct/100) / (atrValue * stopMult)
 * Returns quantity in base asset units. 0 if inputs invalid.
 */
export function positionSize(
  equity: number,
  riskPct: number,
  atrValue: number,
  stopMult: number,
): number {
  if (equity <= 0 || riskPct <= 0 || atrValue <= 0 || stopMult <= 0) return 0;
  return (equity * (riskPct / 100)) / (atrValue * stopMult);
}
