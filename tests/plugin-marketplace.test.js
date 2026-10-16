import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { updatePluginMarketplaceFile } from "../scripts/update-plugin-marketplace.js";

const catalog = JSON.parse(await readFile(new URL("../.agents/plugins/marketplace.json", import.meta.url), "utf8"));
test("public marketplace installs only the packaged release identity", () => {
  assert.equal(catalog.name, "taskchef");
  assert.deepEqual(catalog.plugins.map(p => p.name), ["taskchef"]);
  assert.equal(catalog.plugins[0].source.source, "npm");
  assert.equal(catalog.plugins[0].source.package, "taskchef");
  assert.match(catalog.plugins[0].source.version, /^\d+\.\d+\.\d+$/);
  assert.equal(catalog.plugins[0].policy.installation, "AVAILABLE");
});
test("catalog update preserves metadata, is idempotent, and rejects invalid versions without writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-catalog-"));
  try {
    const file = path.join(root, "marketplace.json");
    const fixture = structuredClone(catalog);
    fixture.plugins[0].source.version = "0.0.0";
    await writeFile(file, JSON.stringify(fixture));
    assert.equal((await updatePluginMarketplaceFile(file, "9.3.0")).changed, true);
    const updated = JSON.parse(await readFile(file, "utf8"));
    assert.equal(updated.plugins[0].source.version, "9.3.0");
    assert.deepEqual(updated.plugins[0].policy, catalog.plugins[0].policy);
    assert.deepEqual(updated.interface, catalog.interface);
    assert.equal((await updatePluginMarketplaceFile(file, "9.3.0")).changed, false);
    const before = await readFile(file, "utf8");
    await assert.rejects(updatePluginMarketplaceFile(file, "latest"), /invalid/);
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("feedback forms have valid YAML and required problem fields", async () => {
  for (const name of ["bug_report", "feature_request"]) {
    const form = parse(await readFile(new URL(`../.github/ISSUE_TEMPLATE/${name}.yml`, import.meta.url), "utf8"));
    assert.ok(form.name && form.description);
    assert.ok(form.body.some(field => field.type === "textarea" && field.validations?.required));
    assert.equal(new Set(form.body.map(field => field.id)).size, form.body.length);
  }
});
