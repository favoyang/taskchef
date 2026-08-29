import { existsSync } from "node:fs";
import path from "node:path";

const [packageName, binaryName] = process.argv.slice(2);
if (!/^@ccusage\/ccusage-(?:darwin|linux|win32)-(?:arm64|x64)$/u.test(packageName ?? "")
  || !/^ccusage(?:\.exe)?$/u.test(binaryName ?? "")) {
  process.exit(1);
}

const binDirectory = process.env.PATH
  ?.split(path.delimiter)
  .find((entry) => entry.endsWith(path.join("node_modules", ".bin")));
const binary = binDirectory
  ? path.join(path.dirname(binDirectory), packageName, "bin", binaryName)
  : null;
if (binary === null || !existsSync(binary)) process.exit(1);
process.stdout.write(binary);
