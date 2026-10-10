import { expect, test } from "vitest";
import { compactTokens, savedUsageCost } from "./SavedUsageFormat";
test("formats token units with two decimal places and promotes rounded boundaries", () => {
  expect([0, 999, 3210, 4230000, 5390000000, 999999].map(compactTokens)).toEqual(["0", "999", "3.21K", "4.23M", "5.39B", "1.00M"]);
});

test("an unknown price keeps the incomplete marker on the cost placeholder", () => {
  const usage={tokens:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0,total_tokens:11},samples:1,costUsd:0,costPartial:true,partial:false};
  expect(savedUsageCost(usage)).toBe("—*");
  expect(savedUsageCost({...usage,costPartial:false})).toBe("$0.00");
});
