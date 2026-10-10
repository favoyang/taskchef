import { expect, test } from "vitest";
import { compactTokens } from "./SavedUsageFormat";
test("formats token units with two decimal places and promotes rounded boundaries", () => {
  expect([0, 999, 3210, 4230000, 5390000000, 999999].map(compactTokens)).toEqual(["0", "999", "3.21K", "4.23M", "5.39B", "1.00M"]);
});
