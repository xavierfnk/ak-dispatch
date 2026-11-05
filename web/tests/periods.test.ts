import { strict as assert } from "node:assert";
import { test } from "node:test";
import { splitMonth } from "../src/periods.ts";

test("month splits cover leap February with consecutive balanced periods", () => {
  assert.deepEqual(splitMonth("2028-02", 4), [
    { start: 1, end: 8 }, { start: 9, end: 15 }, { start: 16, end: 22 }, { start: 23, end: 29 },
  ]);
});

test("one to four cohorts cover each month without gaps or overlaps", () => {
  for (const [month, days] of [["2027-02", 28], ["2028-02", 29], ["2027-04", 30], ["2027-01", 31]] as const) {
    for (let count = 1; count <= 4; count++) {
      const periods = splitMonth(month, count);
      assert.equal(periods.length, count);
      assert.equal(periods[0].start, 1);
      assert.equal(periods.at(-1)?.end, days);
      const lengths = periods.map((period, index) => {
        if (index > 0) assert.equal(period.start, periods[index - 1].end + 1);
        return period.end - period.start + 1;
      });
      assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
    }
  }
});
