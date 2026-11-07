export function readFiscalNumber(raw: string, label: string): number {
  const value = raw.trim();
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    throw new Error(`Enter a number for ${label}. Blank is not zero.`);
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`${label} must be a finite number.`);
  return number;
}
