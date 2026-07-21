export const toBaseUnits = (value: string, decimals = 7): bigint => {
  const raw = value.trim();
  if (!/^\d*(\.\d*)?$/.test(raw) || raw === '' || raw === '.') throw new Error('Invalid amount');
  const [whole = '0', fraction = ''] = raw.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
};

export const fromBaseUnits = (value: bigint | number | string | undefined, decimals = 7, precision = 4): string => {
  if (value === undefined) return '—';
  const n = BigInt(value);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString()}${frac ? `.${frac}` : ''}`;
};

export const short = (value?: string, left = 5, right = 5) => value ? `${value.slice(0,left)}…${value.slice(-right)}` : '—';
export const bps = (value: unknown) => `${Number(value ?? 0) / 100}%`;
