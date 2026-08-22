// grid.mjs — the one rounding rule for plan times (references/reframe.md, the float law).
// Two grids meet in plan.json: NanoClip's word grid (2dp-true seconds) and the proxy's
// frame grid (k/30, no finite decimal). Arithmetic on 2dp values leaves float noise
// (89.46 - 52.56 = 36.89999…); a 1/30 value is a real fraction. exact2 strips the noise
// and passes the grid value through as the exact double — it never rounds a grid
// value to 2dp (rounding to nearest is how a stray frame gets into a segment edge).
export function exact2(v) {
  const stripped = Math.round(v * 100) / 100;
  return Math.abs(v - stripped) < 1e-9 ? stripped : v;
}
