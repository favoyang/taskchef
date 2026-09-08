import { open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { taskChefError } from "./state-store.js";

export async function appendAuditUnlocked(workspace, record) {
  const filePath = path.join(workspace, "config-audit.jsonl");
  const size = await stat(filePath).then((details) => details.size).catch((error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  if (size >= 10 * 1024 * 1024) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    await rename(filePath, path.join(workspace, `config-audit.${timestamp}.jsonl`));
    const archives = (await readdir(workspace))
      .filter((name) => /^config-audit\..+\.jsonl$/.test(name))
      .sort()
      .reverse();
    for (const name of archives.slice(10)) await unlink(path.join(workspace, name));
  }
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, ...record })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLatestAuditRecordsUnlocked(workspace) {
  const filePath = path.join(workspace, "config-audit.jsonl");
  const content = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const latest = new Map();
  for (const [index, line] of content.trimEnd().split("\n").entries()) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw taskChefError(
        "STATE_RECOVERY_REQUIRED",
        `configuration audit is malformed at line ${index + 1}`,
      );
    }
    if (record.transactionId) latest.set(record.transactionId, record);
  }
  return latest;
}

export async function validateAuditUnlocked(workspace) {
  await readLatestAuditRecordsUnlocked(workspace);
}

export async function reconcileAuditUnlocked(workspace, currentHash) {
  const latest = await readLatestAuditRecordsUnlocked(workspace);
  for (const record of latest.values()) {
    if (record.phase !== "prepared" && record.phase !== "recovery-required") continue;
    if (currentHash === record.beforeHash) {
      await appendAuditUnlocked(workspace, {
        ...record,
        timestamp: new Date().toISOString(),
        phase: "aborted",
        reconciliation: "matched-before",
      });
    } else if (currentHash === record.afterHash) {
      await appendAuditUnlocked(workspace, {
        ...record,
        timestamp: new Date().toISOString(),
        phase: "committed",
        reconciliation: "matched-after",
      });
    } else {
      throw taskChefError(
        "STATE_RECOVERY_REQUIRED",
        `configuration does not match either side of transaction ${record.transactionId}`,
        { transactionId: record.transactionId },
      );
    }
  }
}

export async function supersedeAuditTransactionsUnlocked(workspace, recoveryTransactionId) {
  const latest = await readLatestAuditRecordsUnlocked(workspace);
  const superseded = [];
  for (const record of latest.values()) {
    if (record.transactionId === recoveryTransactionId
        || !new Set(["prepared", "recovery-required"]).has(record.phase)) continue;
    await appendAuditUnlocked(workspace, {
      ...record,
      timestamp: new Date().toISOString(),
      phase: "superseded",
      supersededBy: recoveryTransactionId,
    });
    superseded.push(record.transactionId);
  }
  return superseded;
}
