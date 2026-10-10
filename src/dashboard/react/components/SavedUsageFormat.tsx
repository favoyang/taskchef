import { Stack, Text } from "@mantine/core";
import type { SavedUsage } from "../types";

export function compactTokens(value: number) {
  const units = ["", "K", "M", "B", "T"];
  let amount = value, unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  if (unit && Number(amount.toFixed(2)) >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return unit ? `${amount.toFixed(2)}${units[unit]}` : amount.toLocaleString();
}

export function savedUsageCost(value: SavedUsage) {
  if (!value.samples || (value.costPartial && value.costUsd === 0)) return value.costPartial ? "—*" : "—";
  return `$${value.costUsd.toFixed(2)}${value.costPartial ? "*" : ""}`;
}

export function turnUsageLabel(value: SavedUsage) {
  return `${value.samples ? compactTokens(value.tokens.total_tokens) : "—"}${value.partial ? "*" : ""} / ${savedUsageCost(value)}`;
}

export function TokenBreakdown({ value }: { value: SavedUsage }) {
  return <Stack gap={2}>
    <Text inherit>Input: {value.tokens.input_tokens.toLocaleString()}</Text>
    <Text inherit>Cached input: {value.tokens.cached_input_tokens.toLocaleString()}</Text>
    <Text inherit>Cache writes: {value.tokens.cache_write_input_tokens.toLocaleString()}</Text>
    <Text inherit>Output: {value.tokens.output_tokens.toLocaleString()}</Text>
    <Text inherit>Reasoning: {value.tokens.reasoning_output_tokens.toLocaleString()} (included in output)</Text>
    {value.partial && <Text inherit>Some saved usage records or turn links are missing or incomplete.</Text>}
  </Stack>;
}
