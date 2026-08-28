import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");

export const TASKCHEF_VERSION = packageMetadata.version;
export const DASHBOARD_SERVER_VERSION = "3";
