export function nextBackoffMs(attempt: number): number {
  const base = 1000;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 30000);
}
