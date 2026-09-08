import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function semanticHash(value, domain = "taskchef") {
  return sha256(`${domain}\n${canonicalJson(value)}\n`);
}

export function taskChefError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export async function writeDurableAtomic(filePath, content, {
  mode = 0o600,
  exclusive = false,
} = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let replacementCommitted = false;
  try {
    if (exclusive) {
      await link(temporaryPath, filePath);
      replacementCommitted = true;
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, filePath);
      replacementCommitted = true;
    }
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    if (replacementCommitted) error.replacementCommitted = true;
    throw error;
  }
}

export async function removeDurable(filePath) {
  let removed = false;
  try {
    await unlink(filePath);
    removed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!removed) return false;
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}
