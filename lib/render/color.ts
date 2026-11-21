/** OKLCH → linear sRGB. OKLCH keeps perceived lightness even across hues. */
export function oklch(L: number, C: number, hueTurns: number): [number, number, number] {
  const h = hueTurns * 2 * Math.PI;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function toCss([r, g, b]: [number, number, number]): string {
  const enc = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
  return `rgb(${enc(r)} ${enc(g)} ${enc(b)})`;
}
