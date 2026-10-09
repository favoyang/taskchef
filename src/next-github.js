import { filterTasks } from "./dashboard/state.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireWorkspaceLock } from "./workspace.js";

const DEVICE_URL = "https://github.com/login/device";
const CACHE_MS = 60_000;
export function pullRequestIdentity(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

// The native library keeps secrets in Keychain, Credential Manager, or Secret Service.
// It is loaded only for sign-in; an unavailable credential store never falls back to a file.
export class GitHubCredentials {
  async entry(clientId) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("TaskChef Next GitHub", clientId, { linux: { store: "secret-service" } });
  }
  async read(clientId) { const value = await (await this.entry(clientId)).getPassword(); return value ? JSON.parse(value) : {}; }
  async write(clientId, value) { await (await this.entry(clientId)).setPassword(JSON.stringify(value)); }
  async remove(clientId) { await (await this.entry(clientId)).deletePassword(); }
}

export class NextGitHub {
  constructor({ stateDir, credentials = new GitHubCredentials(), fetch = globalThis.fetch, now = Date.now } = {}) {
    this.stateDir = stateDir; this.credentials = credentials; this.fetch = fetch; this.now = now;
    this.cache = new Map(); this.lastClient = null; this.lastLogin = null; this.retryUntil = 0;
  }
  async locked(operation) {
    await mkdir(join(this.stateDir, "github-auth"), { recursive: true, mode: 0o700 });
    const release = await acquireWorkspaceLock(join(this.stateDir, "github-auth"));
    try { return await operation(); } finally { await release(); }
  }
  async request(url, { token, form, query } = {}) {
    if (this.retryUntil > this.now()) throw new Error("GitHub is rate limited. Try again later.");
    let response;
    try {
      response = await this.fetch(url, { method: form || query ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers: {
        Accept: "application/json", "User-Agent": "TaskChef-Next", ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(query ? { "Content-Type": "application/json" } : {}),
      }, ...(form ? { body: new URLSearchParams(form) } : query ? { body: JSON.stringify({ query }) } : {}) });
    } catch { throw new Error("GitHub could not be reached. Try again."); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "GitHub sign-in expired. Sign in again." : response.status === 403 || response.status === 429 ? "GitHub access is blocked or rate limited. Check repository access and try later." : "GitHub could not return PR status.");
      error.status = response.status;
      if (response.status === 403 || response.status === 429) {
        const retry = Number(response.headers?.get("retry-after"));
        this.retryUntil = this.now() + Math.max(CACHE_MS, Number.isFinite(retry) ? retry * 1000 : CACHE_MS);
      }
      throw error;
    }
    try { return await response.json(); } catch { throw new Error("GitHub returned an invalid response."); }
  }
  async readCredential(clientId) {
    try {
      const value = await this.credentials.read(clientId);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || (value.token && (typeof value.token !== "string" || typeof value.login !== "string"))
        || (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
        || (value.expiresAt != null && !Number.isFinite(value.expiresAt))
        || (value.pending && (typeof value.pending.deviceCode !== "string" || typeof value.pending.userCode !== "string"
          || ![value.pending.expiresAt, value.pending.interval, value.pending.nextPoll].every(Number.isFinite)))) throw new Error();
      return value;
    } catch { throw new Error("Cannot read the system credential store. Unlock it and try again."); }
  }
  async save(clientId, value) {
    try { await this.credentials.write(clientId, value); }
    catch { throw new Error("Cannot save GitHub sign-in in the system credential store. No token was saved to a file."); }
  }
  publicAuth(value, configured = true) {
    return { configured, connected: Boolean(value.token), login: value.login ?? null,
      ...(value.pending ? { pending: { userCode: value.pending.userCode, verificationUrl: DEVICE_URL, expiresAt: value.pending.expiresAt } } : {}) };
  }
  async tokenBundle(clientId, value) {
    if (!value.token || !value.expiresAt || value.expiresAt > this.now() + 30_000) return value;
    if (!value.refreshToken) throw new Error("GitHub sign-in expired. Sign in again.");
    const result = await this.request("https://github.com/login/oauth/access_token", { form: { client_id: clientId, grant_type: "refresh_token", refresh_token: value.refreshToken } });
    if (result.error || typeof result.access_token !== "string" || typeof result.refresh_token !== "string" || !Number.isFinite(result.expires_in)) { await this.save(clientId, {}); throw new Error("GitHub sign-in expired. Sign in again."); }
    const next = { token: result.access_token, refreshToken: result.refresh_token, expiresAt: this.now() + result.expires_in * 1000, login: value.login };
    await this.save(clientId, next);
    return next;
  }
  async auth(clientId, action = "status") {
    if (!clientId) {
      if (action !== "status") throw new Error("Register the GitHub App and set its public client ID in plugin settings first.");
      return { configured: false, connected: false, login: null };
    }
    return this.locked(async () => {
      let value = await this.readCredential(clientId);
      if (action === "disconnect") {
        try { await this.credentials.remove(clientId); } catch { throw new Error("Cannot remove GitHub sign-in from the system credential store."); }
        this.cache.clear();
        return this.publicAuth({});
      }
      if (action === "start") {
        const result = await this.request("https://github.com/login/device/code", { form: { client_id: clientId, scope: "offline_access" } });
        if (result.error || typeof result.device_code !== "string" || typeof result.user_code !== "string" || !Number.isFinite(result.expires_in) || !Number.isFinite(result.interval)) throw new Error("GitHub device sign-in is unavailable. Check the app's client ID and enable device flow.");
        value = { pending: { deviceCode: result.device_code, userCode: result.user_code, expiresAt: this.now() + result.expires_in * 1000, interval: Math.max(5, result.interval) * 1000, nextPoll: this.now() + Math.max(5, result.interval) * 1000 } };
        await this.save(clientId, value);
        this.cache.clear();
      } else if (action === "poll" && value.pending) {
        const pending = value.pending;
        if (pending.expiresAt <= this.now()) { await this.save(clientId, {}); throw new Error("GitHub sign-in code expired. Start again."); }
        if (pending.nextPoll <= this.now()) {
          // Persist the deadline before requesting, so another MCP process cannot poll too soon.
          pending.nextPoll = this.now() + pending.interval;
          await this.save(clientId, value);
          const result = await this.request("https://github.com/login/oauth/access_token", { form: { client_id: clientId, device_code: pending.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" } });
          if (result.error === "slow_down") { pending.interval += 5000; pending.nextPoll = this.now() + pending.interval; await this.save(clientId, value); }
          else if (result.error === "authorization_pending") { /* The user has not approved yet. */ }
          else if (result.error || typeof result.access_token !== "string") { await this.save(clientId, {}); throw new Error("GitHub sign-in was denied or expired. Start again."); }
          else {
            const user = await this.request("https://api.github.com/user", { token: result.access_token });
            if (typeof user.login !== "string") throw new Error("GitHub could not verify your account.");
            value = { token: result.access_token, refreshToken: result.refresh_token, expiresAt: result.expires_in ? this.now() + result.expires_in * 1000 : null, login: user.login };
            await this.save(clientId, value);
            this.cache.clear();
          }
        }
      }
      return this.publicAuth(value);
    });
  }
  async enrich(snapshot, settings, { force = false, scope = {} } = {}) {
    if (!snapshot.healthy) return { snapshot, auth: { configured: Boolean(settings.githubClientId), connected: false, login: null } };
    const clientId = settings.githubClientId;
    const requestedIds = scope.taskIds === undefined ? null : new Set(scope.taskIds);
    const urls = [...new Set(filterTasks(snapshot.tasks, { date: scope.date ?? "all", now: this.now() }).filter((task) => (!requestedIds || requestedIds.has(task.id)) && (!scope.project || (task.project?.id || task.project?.path || task.project?.name) === scope.project) && !task.observed.archive && (settings.showCli || task.observed.source !== "cli") && (settings.showExec || task.observed.source !== "exec")).flatMap((task) => (task.pullRequests ?? []).map((pr) => pr.url)))];
    let auth = { configured: Boolean(clientId), connected: false, login: null };
    if (clientId) {
      try {
        await this.locked(async () => {
          let value = await this.readCredential(clientId);
          if (clientId !== this.lastClient || value.login !== this.lastLogin) this.cache.clear();
          this.lastClient = clientId; this.lastLogin = value.login;
          auth = this.publicAuth(value);
          if (!value.token) { this.cache.clear(); return; }
          value = await this.tokenBundle(clientId, value);
          const needed = urls.filter((url) => pullRequestIdentity(url) && (force || !this.cache.has(url) || (this.cache.get(url).pr.state !== "merged" && this.cache.get(url).expiresAt <= this.now())))
            .sort((a, b) => (this.cache.get(a)?.expiresAt ?? 0) - (this.cache.get(b)?.expiresAt ?? 0)).slice(0, 25);
          for (let start = 0; start < needed.length; start += 25) {
            const batch = needed.slice(start, start + 25);
            const query = `query { ${batch.map((url, i) => {
              const p = pullRequestIdentity(url);
              return `p${i}: repository(owner:${JSON.stringify(p.owner)},name:${JSON.stringify(p.repo)}) { pullRequest(number:${p.number}) { state merged isDraft headRefOid commits(last:1) { nodes { commit { statusCheckRollup { state } } } } } }`;
            }).join(" ")} }`;
            let result;
            try { result = await this.request("https://api.github.com/graphql", { token: value.token, query }); }
            catch (error) {
              for (const url of batch) this.cache.set(url, { expiresAt: this.now() + CACHE_MS, pr: { url, state: "unknown", checks: "unknown", error: error.message } });
              auth = { ...auth, error: error.message };
              if (error.status === 401) { await this.save(clientId, {}); auth.connected = false; this.cache.clear(); break; }
              continue;
            }
            for (const [i, url] of batch.entries()) {
              const p = result.data?.[`p${i}`]?.pullRequest;
              const failed = result.errors?.some((error) => !error.path || error.path[0] === `p${i}`);
              const state = failed || !p ? "unknown" : p.merged === true ? "merged" : p.state === "CLOSED" ? "closed" : p.state === "OPEN" ? p.isDraft ? "draft" : "open" : "unknown";
              const rollup = p?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
              const checks = failed || !p ? "unknown" : rollup === null ? "none" : rollup?.state === "SUCCESS" ? "passed" : ["ERROR", "FAILURE"].includes(rollup?.state) ? "failed" : ["PENDING", "EXPECTED"].includes(rollup?.state) ? "pending" : "unknown";
              this.cache.set(url, { expiresAt: this.now() + CACHE_MS, pr: { url, state, checks, checkedAt: new Date(this.now()).toISOString(), ...(state === "unknown" ? { error: "PR status unavailable. Check the app's repository access." } : {}) } });
            }
          }
        });
      } catch (error) { auth = { ...auth, connected: false, error: error.message }; this.cache.clear(); }
    } else this.cache.clear();
    const tasks = snapshot.tasks.map((task) => {
      const pullRequests = (task.pullRequests ?? []).map((pr) => this.cache.get(pr.url)?.pr ?? { ...pr, state: "unknown", checks: "unknown", error: pullRequestIdentity(pr.url) ? auth.connected ? "Waiting for the next GitHub check." : "Connect GitHub to read PR status." : "This GitHub host or PR URL is not supported." });
      if (task.observed.lastTurnEvent !== "completed" || task.observed.archive) return { ...task, pullRequests };
      // A routine completion returns to its schedule regardless of GitHub access or PR state.
      if (task.scheduled && task.inputSource === "scheduled") return {
        ...task, pullRequests, status: "scheduled", statusLabel: "Scheduled",
        summary: "Latest scheduled turn ended; an active schedule remains.",
      };
      if (!pullRequests.length) return { ...task, pullRequests };
      const allMerged = pullRequests.every((pr) => pr.state === "merged");
      const status = allMerged ? task.scheduled ? "scheduled" : "completed" : "needs_input";
      return { ...task, pullRequests, status,
        statusLabel: status === "scheduled" ? "Scheduled" : status === "completed" ? "Done" : "Waiting for input/review",
        summary: allMerged ? task.scheduled ? "Latest-turn PRs are merged; an active schedule remains." : "Latest-turn PRs are merged."
          : "Latest-turn PRs need review or confirmed merge status.",
      };
    });
    return { snapshot: { ...snapshot, tasks }, auth };
  }
}
