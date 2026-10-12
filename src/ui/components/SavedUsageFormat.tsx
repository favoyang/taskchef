import { Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@mantine/hooks";
import type { SavedUsage } from "../types";

export function compactTokens(value: number) {
  const units = ["", "K", "M", "B", "T"];
  let amount = value, unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  if (unit && Number(amount.toFixed(2)) >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return unit ? `${amount.toFixed(2)}${units[unit]}` : amount.toLocaleString();
}

export function savedUsageCost(value: SavedUsage) {
  if (!value.samples || (value.costPartial && value.costUsd === 0)) return "—";
  return `$${value.costUsd.toFixed(2)}`;
}

export function turnUsageLabel(value: SavedUsage) {
  return `${value.samples ? compactTokens(value.tokens.total_tokens) : "—"} • ${savedUsageCost(value)}`;
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


export function useAnimatedUsage(value: SavedUsage | undefined, running: boolean, identity?: string | null) {
  const reducedMotion = useReducedMotion();
  const targetTokens = value?.tokens.total_tokens ?? 0;
  const targetCost = value?.costUsd ?? 0;
  const current = useRef({ tokens: 0, cost: 0, identity });
  const [display, setDisplay] = useState(() => running && !reducedMotion ? { tokens: 0, cost: 0 } : { tokens: targetTokens, cost: targetCost });
  useEffect(() => {
    const target = { tokens: targetTokens, cost: targetCost };
    const from = current.current.identity === identity ? current.current : { tokens: 0, cost: 0 };
    current.current = { ...from, identity };
    if (!running || reducedMotion || (from.tokens === targetTokens && from.cost === targetCost)) {
      current.current = { ...target, identity };
      setDisplay(target);
      return;
    }
    setDisplay(from);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - started) / 800));
      const eased = 1 - (1 - progress) ** 3;
      const next = progress === 1 ? target : { tokens: from.tokens + (targetTokens - from.tokens) * eased, cost: from.cost + (targetCost - from.cost) * eased };
      current.current = { ...next, identity };
      setDisplay(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targetTokens, targetCost, running, reducedMotion, identity]);
  if (!value) return undefined;
  const shown = !running || reducedMotion ? { tokens: targetTokens, cost: targetCost }
    : current.current.identity !== identity ? { tokens: 0, cost: 0 } : display;
  return { ...value, tokens: { ...value.tokens, total_tokens: Math.round(shown.tokens) }, costUsd: shown.cost };
}
