import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { sha256, semanticHash, taskChefError } from "./state-store.js";
import { TASKCHEF_VERSION } from "./version.js";

export const BACKUP_FILES = ["taskchef.json", "tasks.jsonl", "AGENTS.md", "config-audit.jsonl"];
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw taskChefError("BACKUP_FAILED", `backup path is not a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw taskChefError("BACKUP_FAILED", `backup path is not owned by the current user: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function filePayload(workspace, name, validateFile) {
  const filePath = path.join(workspace, name);
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw taskChefError("BACKUP_FAILED", `managed state is not a regular file: ${filePath}`);
    }
    if (details.size > MAX_SOURCE_FILE_BYTES) {
      throw taskChefError("BACKUP_FAILED", `managed state exceeds the backup size limit: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    let valid = true;
    try {
      if (name === "taskchef.json") {
        const config = JSON.parse(bytes.toString("utf8"));
        valid = config?.schemaVersion === 2 && Array.isArray(config.projects);
      } else if (name.endsWith(".jsonl")) {
        for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
          if (line) JSON.parse(line);
        }
      }
      if (validateFile) await validateFile(name, bytes);
    } catch {
      valid = false;
    }
    return { present: true, size: bytes.length, sha256: sha256(bytes), bytes, valid };
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, size: 0, sha256: null, bytes: null };
    throw error;
  }
}

async function readManifest(snapshotPath) {
  const manifest = JSON.parse(await readFile(path.join(snapshotPath, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.workspace.length === 0) {
    throw new Error("unsupported backup manifest");
  }
  return manifest;
}

export async function verifyBackup(workspace, id) {
  if (!/^[0-9TZ.-]+-[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid backup ID");
  const snapshotPath = path.join(workspace, "backups", id);
  let manifest = null;
  try {
    const snapshotDetails = await lstat(snapshotPath);
    if (!snapshotDetails.isDirectory() || snapshotDetails.isSymbolicLink()
        || (snapshotDetails.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && snapshotDetails.uid !== process.getuid())) {
      throw new Error("backup snapshot permissions or ownership are unsafe");
    }
    manifest = await readManifest(snapshotPath);
    if (manifest.workspace !== workspace) throw new Error("backup belongs to a different workspace");
    if (manifest.id !== id) throw new Error("backup manifest ID does not match its directory");
    const snapshotNames = await readdir(snapshotPath);
    const allowedNames = new Set(["manifest.json", ...BACKUP_FILES.filter(
      (name) => manifest.files?.[name]?.present,
    )]);
    const unexpected = snapshotNames.find((name) => !allowedNames.has(name));
    if (unexpected) throw new Error(`backup contains an unexpected payload: ${unexpected}`);
    for (const name of BACKUP_FILES) {
      const expected = manifest.files[name];
      if (!expected) throw new Error(`manifest is missing ${name}`);
      if (!expected.present) continue;
      const details = await lstat(path.join(snapshotPath, name));
      if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0
          || (typeof process.getuid === "function" && details.uid !== process.getuid())) {
        throw new Error(`backup payload permissions are unsafe: ${name}`);
      }
      const bytes = await readFile(path.join(snapshotPath, name));
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
        throw new Error(`backup payload failed verification: ${name}`);
      }
    }
    const manifestDetails = await lstat(path.join(snapshotPath, "manifest.json"));
    if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink()
        || (manifestDetails.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && manifestDetails.uid !== process.getuid())) {
      throw new Error("backup manifest permissions are unsafe");
    }
    if (manifest.validationStatus !== "valid") {
      return {
        id,
        usable: false,
        integrityValid: true,
        path: snapshotPath,
        manifest,
        error: "backup contains invalid source state and is forensic-only",
      };
    }
    return { id, usable: true, integrityValid: true, path: snapshotPath, manifest };
  } catch (error) {
    return {
      id,
      usable: false,
      integrityValid: false,
      path: snapshotPath,
      ...(manifest ? { manifest } : {}),
      error: error.message,
    };
  }
}

export async function listBackups(workspace) {
  const root = path.join(workspace, "backups");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const backups = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith(".tmp-"))) {
    backups.push(await verifyBackup(workspace, entry.name));
  }
  backups.sort((left, right) => right.id.localeCompare(left.id));
  const backupBytes = (item) => item.manifest?.files
    ? Object.values(item.manifest.files)
      .reduce((sum, file) => sum + (file.present ? file.size : 0), 0)
    : 0;
  const usableBytes = backups.filter((item) => item.usable)
    .reduce((sum, item) => sum + backupBytes(item), 0);
  const forensicBytes = backups.filter((item) => item.integrityValid && !item.usable)
    .reduce((sum, item) => sum + backupBytes(item), 0);
  const corruptBytes = backups.filter((item) => !item.integrityValid)
    .reduce((sum, item) => sum + backupBytes(item), 0);
  return {
    schemaVersion: 1,
    backupCount: backups.length,
    usableCount: backups.filter((item) => item.usable).length,
    forensicCount: backups.filter((item) => item.integrityValid && !item.usable).length,
    corruptCount: backups.filter((item) => !item.integrityValid).length,
    usableBytes,
    forensicBytes,
    corruptBytes,
    totalBytes: usableBytes + forensicBytes + corruptBytes,
    backups,
  };
}

export async function createBackupUnlocked(workspace, {
  reason = "manual",
  now = () => new Date().toISOString(),
  validateFile = null,
} = {}) {
  const root = path.join(workspace, "backups");
  await privateDirectory(root);
  const payloads = Object.fromEntries(await Promise.all(BACKUP_FILES.map(async (name) => [
    name, await filePayload(workspace, name, validateFile),
  ])));
  const aggregateHash = semanticHash(Object.fromEntries(
    BACKUP_FILES.map((name) => [name, {
      present: payloads[name].present,
      size: payloads[name].size,
      sha256: payloads[name].sha256,
    }]),
  ), "taskchef-backup-v1");
  const existing = (await listBackups(workspace)).backups.find(
    (item) => item.usable && item.manifest.aggregateHash === aggregateHash,
  );
  if (existing) return { ...existing, deduplicated: true, reason };

  const timestamp = now().replaceAll(":", "-").replaceAll(".", "-");
  const id = `${timestamp}-${randomUUID()}`;
  const staging = path.join(root, `.tmp-${id}`);
  const destination = path.join(root, id);
  await mkdir(staging, { mode: 0o700 });
  try {
    const files = {};
    for (const name of BACKUP_FILES) {
      const payload = payloads[name];
      files[name] = {
        present: payload.present,
        size: payload.size,
        sha256: payload.sha256,
        valid: payload.present ? payload.valid : null,
      };
      if (!payload.present) continue;
      const handle = await open(path.join(staging, name), "wx", 0o600);
      try {
        await handle.writeFile(payload.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    let projectCount = null;
    let configSchemaVersion = null;
    let taskCount = null;
    try {
      const config = JSON.parse(payloads["taskchef.json"].bytes.toString("utf8"));
      projectCount = Array.isArray(config.projects) ? config.projects.length : null;
      configSchemaVersion = config.schemaVersion ?? null;
    } catch {}
    if (payloads["tasks.jsonl"].present && payloads["tasks.jsonl"].valid) {
      taskCount = payloads["tasks.jsonl"].bytes.toString("utf8").trimEnd().split("\n")
        .filter(Boolean).length;
    }
    const manifest = {
      schemaVersion: 1,
      id,
      createdAt: now(),
      reason,
      taskChefVersion: TASKCHEF_VERSION,
      workspace,
      aggregateHash,
      validationStatus: Object.values(payloads)
        .every((payload) => !payload.present || payload.valid) ? "valid" : "invalid",
      configSchemaVersion,
      projectCount,
      taskCount,
      auditBoundary: payloads["config-audit.jsonl"].present
        ? payloads["config-audit.jsonl"].sha256
        : null,
      files,
    };
    const manifestHandle = await open(path.join(staging, "manifest.json"), "wx", 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    const stagingHandle = await open(staging, "r");
    try { await stagingHandle.sync(); } finally { await stagingHandle.close(); }
    await rename(staging, destination);
    const rootHandle = await open(root, "r");
    try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    const verified = await verifyBackup(workspace, id);
    if (!verified.usable && !verified.integrityValid) throw new Error(verified.error);
    if (!verified.usable) {
      return { ...verified, deduplicated: false, forensic: true, reason };
    }
    const retention = await pruneBackupsUnlocked(workspace, { apply: true });
    return {
      ...verified,
      deduplicated: false,
      reason,
      storagePressure: retention.remainingBytes > MAX_BACKUP_BYTES,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw taskChefError("BACKUP_FAILED", `backup creation failed: ${error.message}`);
  }
}

export async function pruneBackupsUnlocked(workspace, { apply = false } = {}) {
  const inventory = await listBackups(workspace);
  const usable = inventory.backups.filter((item) => item.usable);
  const preferred = new Set(usable.slice(0, 30).map((item) => item.id));
  const daily = new Set();
  const newestTime = usable.length > 0 ? Date.parse(usable[0].manifest.createdAt) : 0;
  for (const item of usable) {
    const day = item.manifest.createdAt.slice(0, 10);
    const dayTime = Date.parse(`${day}T00:00:00.000Z`);
    const ageDays = Math.floor((newestTime - dayTime) / 86_400_000);
    if (ageDays >= 0 && ageDays < 30 && !daily.has(day)) {
      daily.add(day);
      preferred.add(item.id);
    }
  }
  let totalBytes = 0;
  for (const item of usable) {
    totalBytes += Object.values(item.manifest.files).reduce((sum, file) => sum + file.size, 0);
  }
  const protectedIds = new Set(usable.slice(0, 1).map((item) => item.id));
  const preRestore = usable.find((item) => item.manifest.reason === "pre-restore");
  if (preRestore) protectedIds.add(preRestore.id);
  const audit = await readFile(path.join(workspace, "config-audit.jsonl"), "utf8").catch(() => "");
  const transactions = new Map();
  for (const line of audit.trimEnd().split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.transactionId) transactions.set(record.transactionId, record);
    } catch {}
  }
  for (const record of transactions.values()) {
    if (new Set(["prepared", "recovery-required"]).has(record.phase) && record.backupId) {
      protectedIds.add(record.backupId);
    }
  }
  const candidates = [
    ...usable.filter((item) => !preferred.has(item.id)).reverse(),
    ...usable.filter((item) => preferred.has(item.id)).reverse(),
  ].filter((item, index, items) =>
    !protectedIds.has(item.id) && items.findIndex((candidate) => candidate.id === item.id) === index);
  const removed = [];
  for (const item of candidates) {
    if (preferred.has(item.id) && totalBytes <= MAX_BACKUP_BYTES) continue;
    const bytes = Object.values(item.manifest.files).reduce((sum, file) => sum + file.size, 0);
    if (apply) await rm(item.path, { recursive: true });
    totalBytes -= bytes;
    removed.push(item.id);
  }
  return { schemaVersion: 1, apply, removed, remainingBytes: totalBytes };
}

export async function readBackupConfig(workspace, id) {
  const verified = await verifyBackup(workspace, id);
  if (!verified.usable) throw taskChefError("BACKUP_FAILED", verified.error);
  const entry = verified.manifest.files["taskchef.json"];
  if (!entry.present) throw taskChefError("BACKUP_FAILED", "backup has no taskchef.json");
  return JSON.parse(await readFile(path.join(verified.path, "taskchef.json"), "utf8"));
}

export async function readBackupPayloads(workspace, id, names, {
  allowForensic = false,
  allowMissing = false,
} = {}) {
  const verified = await verifyBackup(workspace, id);
  if (!verified.usable && !(allowForensic && verified.integrityValid)) {
    throw taskChefError("BACKUP_FAILED", verified.error);
  }
  const payloads = {};
  for (const name of names) {
    if (!BACKUP_FILES.includes(name)) throw taskChefError("INVALID_INPUT", "unsupported backup payload");
    if (!verified.manifest.files[name].present) {
      if (allowMissing) {
        payloads[name] = null;
        continue;
      }
      throw taskChefError("BACKUP_FAILED", `backup has no ${name}`);
    }
    payloads[name] = await readFile(path.join(verified.path, name));
  }
  return { verified, payloads };
}
