import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeDurableAtomic } from "./state-store.js";

export const PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const WEEK = 7 * 24 * 60 * 60_000;

// Read only the explicitly labelled standard table. Never use batch/fast rates
// as the default or invent a price for an unknown model.
export function parsePricing(markdown) {
  const section = markdown.split("### Standard pricing data\n")[1]?.split(/\n### |\nBatch\n/)[0];
  if (!section) throw new Error("Standard pricing table is missing.");
  const models = {};
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1).map(value => value.trim());
    if (cells.length !== 9 || !/^(gpt-|o[134])/.test(cells[0])) continue;
    const name = cells[0].replace(/ \(<272K context length\)$/, "");
    const values = cells.slice(1).map(value => value === "-" ? null : /^\$\d+(?:\.\d+)?$/.test(value) ? Number(value.slice(1)) : NaN);
    if (values.some(value => value !== null && !Number.isFinite(value)) || values[0] === null || values[3] === null) continue;
    models[name] = { short: values.slice(0, 4), long: values.slice(4) };
  }
  if (!models["gpt-6.1-sol"] || !models["gpt-6-luna"]) throw new Error("Pricing table is incomplete.");
  return models;
}

export function estimateCallCost(usage, model, models) {
  const rates = models[model]?.[usage.input_tokens > 272_000 ? "long" : "short"];
  if (!rates) return null;
  const cached = usage.cached_input_tokens;
  const writes = usage.cache_write_input_tokens;
  const tokens = [usage.input_tokens - cached - writes, cached, writes, usage.output_tokens];
  if (tokens.some((count, i) => count < 0 || (count > 0 && rates[i] == null))) return null;
  // Reasoning output is already included in output_tokens.
  return tokens.reduce((sum, count, i) => sum + count * (rates[i] ?? 0) / 1_000_000, 0);
}

export class CodexPricing {
  constructor({ cachePath, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
    this.cachePath = cachePath; this.now = now; this.fetch = fetchImpl;
    this.pending = null; this.nextCheck = 0;
  }
  async get({ refresh = true } = {}) {
    this.loading ??= this.load();
    await this.loading;
    if (refresh && !this.pending && this.now() >= this.nextCheck) {
      this.nextCheck = this.now() + WEEK;
      this.pending = this.update().catch(() => { this.nextCheck = this.now() + 60 * 60_000; }).finally(() => { this.pending = null; });
    }
    return this.table;
  }
  async load() {
    this.table = JSON.parse(await readFile(new URL("./data/codex-pricing.json", import.meta.url), "utf8"));
    if (!this.cachePath) return;
    try {
      const cached = JSON.parse(await readFile(this.cachePath, "utf8"));
      // Validate cached content with the same parser used for the live source.
      const models = parsePricing(cached.markdown);
      if (Number.isFinite(cached.checkedAt) && cached.checkedAt <= this.now()) {
        this.table = { date: new Date(cached.checkedAt).toISOString().slice(0, 10), models };
        this.nextCheck = cached.checkedAt + WEEK;
      }
    } catch { /* The bundled table remains available offline. */ }
  }
  async update() {
    const response = await this.fetch(PRICING_URL, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Pricing update failed.");
    const markdown = await response.text();
    if (markdown.length > 1_000_000) throw new Error("Pricing response is too large.");
    const models = parsePricing(markdown);
    const checkedAt = this.now();
    if (this.cachePath) {
      await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      await writeDurableAtomic(this.cachePath, JSON.stringify({ markdown, checkedAt }) + "\n");
    }
    this.table = { date: new Date(checkedAt).toISOString().slice(0, 10), models };
  }
}
