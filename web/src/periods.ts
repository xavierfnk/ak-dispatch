export function splitMonth(month: string, count: number): Array<{ start: number; end: number }> {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  let start = 1;
  return Array.from({ length: count }, (_, index) => {
    const end = start + Math.floor(days / count) + Number(index < days % count) - 1;
    const period = { start, end };
    start = end + 1;
    return period;
  });
}
