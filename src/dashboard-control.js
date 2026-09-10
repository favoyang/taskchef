export const DASHBOARD_CONTROL_SHUTDOWN_PATH = "/api/control/shutdown";
export const DASHBOARD_CONTROL_SESSION_PATH = "/api/control/session";
export const DASHBOARD_CONTROL_HEADER = "x-taskchef-control";

const DASHBOARD_IDENTITY_KEYS = Object.freeze([
  "launcher",
  "schemaVersion",
  "serverVersion",
  "service",
  "taskchefVersion",
  "workspace",
]);

export function exactDashboardIdentity(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const valueKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return valueKeys.length === DASHBOARD_IDENTITY_KEYS.length
    && expectedKeys.length === DASHBOARD_IDENTITY_KEYS.length
    && DASHBOARD_IDENTITY_KEYS.every((key, index) => valueKeys[index] === key
      && expectedKeys[index] === key && value[key] === expected[key]);
}

export function validDashboardControlRequest(request, {
  authority,
  origin,
  action,
} = {}) {
  return request.headers.host === authority
    && request.headers.origin === origin
    && request.headers[DASHBOARD_CONTROL_HEADER] === action
    && request.headers["content-type"] === "application/json";
}
