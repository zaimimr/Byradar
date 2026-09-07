const OSLO_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Oslo',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function offsetMinutes(atMs: number): number {
  const parts = OSLO_PARTS.formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (asUtc - atMs) / 60_000;
}

export function osloMidnightUtcMs(yyyymmdd: string): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let result = naive;
  for (let i = 0; i < 3; i++) result = naive - offsetMinutes(result) * 60_000;
  return result;
}

export function secondsIntoServiceDay(serviceDate: string, nowMs = Date.now()): number {
  return (nowMs - osloMidnightUtcMs(serviceDate)) / 1000;
}
