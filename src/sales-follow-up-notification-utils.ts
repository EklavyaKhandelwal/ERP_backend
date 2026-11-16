export function getCompanyDateAndHour(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = new Map(parts.map(part => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = values.get('hour');
  if (!year || !month || !day || !hour) {
    throw new Error('Unable to determine company-local date for Sales notifications.');
  }
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}

export function isSalesFollowUpDigestWindowOpen(hour: number): boolean {
  return hour >= 9;
}

export function salesFollowUpDigestTitle(overdueCount: number, dueTodayCount: number): string {
  const items = [];
  if (overdueCount > 0) items.push(`${overdueCount} overdue`);
  if (dueTodayCount > 0) items.push(`${dueTodayCount} due today`);
  return items.length ? `Sales follow-ups: ${items.join(', ')}` : 'Sales follow-ups: No outstanding items';
}
