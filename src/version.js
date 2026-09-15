import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");

export const TASKCHEF_VERSION = packageMetadata.version;
export const PINNED_CCUSAGE_VERSION = packageMetadata.optionalDependencies?.ccusage ?? null;
export const DASHBOARD_SERVER_VERSION = "4";
