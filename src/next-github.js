import { filterTasks } from "./dashboard/state.js";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";

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
    this.cache = new Map(); this.retryUntil = 0;
  }
  async locked(operation) {
    await mkdir(join(this.stateDir, "github-auth"), { recursive: true, mode: 0o700 });
    const release = await acquireWorkspaceLock(join(this.stateDir, "github-auth"));
    try { return await operation(); } finally { await release(); }
  }
  get cachePath() { return join(this.stateDir, "github-auth", "pr-cache.json"); }
  async clearCache() {
    this.cache.clear();
    await rm(this.cachePath, { force: true });
  }
  async loadCache(clientId, login) {
    this.cache.clear();
    try {
      const saved = JSON.parse(await readFile(this.cachePath, "utf8"));
      if (saved.version !== 1 || typeof saved.entries !== "object" || !saved.entries || Array.isArray(saved.entries)) throw new Error();
      if (saved.clientId !== clientId || saved.login !== login) return;
      for (const [url, entry] of Object.entries(saved.entries)) {
        if (!pullRequestIdentity(url) || entry?.pr?.url !== url || !Number.isFinite(entry.expiresAt)
          || !["unknown", "open", "draft", "closed", "merged"].includes(entry.pr.state)
          || !["unknown", "none", "passed", "failed", "pending"].includes(entry.pr.checks)
          || !entry.turns || typeof entry.turns !== "object" || Array.isArray(entry.turns)
          || Object.values(entry.turns).some(value => typeof value !== "string")) throw new Error();
        this.cache.set(url, entry);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("TaskChef cannot read its saved PR cache. Remove pr-cache.json and refresh.");
    }
  }
  async saveCache(clientId, login) {
    try { await writeDurableAtomic(this.cachePath, JSON.stringify({ version: 1, clientId, login, entries: Object.fromEntries(this.cache) })); }
    catch { throw new Error("TaskChef cannot save its PR cache. Check local file access and refresh."); }
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
      let rateLimited = response.status === 429;
      if (response.status === 403) {
        const body = await response.json().catch(() => null);
        if (/^Resource not accessible by (integration|personal access token)$/i.test(body?.message ?? "")) error.accessIssue = "denied";
        rateLimited = !error.accessIssue && (/rate limit/i.test(body?.message ?? "") || response.headers?.get("x-ratelimit-remaining") === "0" || !!response.headers?.get("retry-after"));
      }
      if (rateLimited) {
        const retry = Number(response.headers?.get("retry-after"));
        this.retryUntil = this.now() + Math.max(CACHE_MS, Number.isFinite(retry) ? retry * 1000 : CACHE_MS);
      }
      throw error;
    }
    try { return await response.json(); } catch { throw new Error("GitHub returned an invalid response."); }
  }
  async checks(identity, sha, token) {
    if (!/^[a-f0-9]{40,64}$/i.test(sha ?? "")) return { checks: "unknown", error: "CI status unavailable: GitHub did not return the head revision." };
    const base = `https://api.github.com/repos/${identity.owner}/${identity.repo}/commits/${sha}`;
    try {
      const [runs, statuses] = await Promise.all([
        this.request(`${base}/check-runs?filter=latest&per_page=100`, { token }),
        this.request(`${base}/status?per_page=100`, { token }),
      ]);
      if (!Array.isArray(runs.check_runs) || !Number.isFinite(runs.total_count) || !Number.isFinite(statuses.total_count)) throw new Error("Invalid CI response.");
      // Never report success when a page omits checks we have not inspected.
      if (runs.total_count > runs.check_runs.length) return { checks: "unknown", error: "CI status unavailable: more than 100 checks. Open GitHub for the full result." };
      const conclusions = runs.check_runs.filter(run => run.status === "completed").map(run => run.conclusion);
      const failed = conclusions.some(value => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(value)) || (statuses.total_count > 0 && ["failure", "error"].includes(statuses.state));
      const pending = runs.check_runs.some(run => run.status !== "completed") || (statuses.total_count > 0 && statuses.state === "pending");
      const unknown = conclusions.some(value => !["success", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(value)) || (statuses.total_count > 0 && !["success", "pending", "failure", "error"].includes(statuses.state));
      return { checks: failed ? "failed" : unknown ? "unknown" : pending ? "pending" : runs.total_count + statuses.total_count === 0 ? "none" : "passed" };
    } catch (error) {
      if (error.status === 401) throw error;
      return { checks: "unknown", ...(error.accessIssue ? { accessIssue: error.accessIssue } : {}), error: "CI status unavailable. Check GitHub repository access and try Refresh." };
    }
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
        await this.clearCache();
        return this.publicAuth({});
      }
      if (action === "start") {
        const result = await this.request("https://github.com/login/device/code", { form: { client_id: clientId, scope: "offline_access" } });
        if (result.error || typeof result.device_code !== "string" || typeof result.user_code !== "string" || !Number.isFinite(result.expires_in) || !Number.isFinite(result.interval)) throw new Error("GitHub device sign-in is unavailable. Check the app's client ID and enable device flow.");
        value = { pending: { deviceCode: result.device_code, userCode: result.user_code, expiresAt: this.now() + result.expires_in * 1000, interval: Math.max(5, result.interval) * 1000, nextPoll: this.now() + Math.max(5, result.interval) * 1000 } };
        await this.save(clientId, value);
        await this.clearCache();
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
            await this.clearCache();
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
    const scopedTasks = filterTasks(snapshot.tasks, { date: scope.date ?? "all", now: this.now() }).filter((task) => (!requestedIds || requestedIds.has(task.id)) && (!scope.project || (task.project?.id || task.project?.path || task.project?.name) === scope.project) && !task.observed.archive && (settings.showCli || task.observed.source !== "cli") && (settings.showExec || task.observed.source !== "exec"));
    const urls = [...new Set(scopedTasks.flatMap(task => (task.pullRequests ?? []).map(pr => pr.url)))];
    const turnsFor = url => Object.fromEntries(scopedTasks.filter(task => task.pullRequests?.some(pr => pr.url === url)).map(task => [task.id, JSON.stringify([task.turnId ?? task.turnRef, task.observed.lastTurnEvent])]));
    let auth = { configured: Boolean(clientId), connected: false, login: null };
    if (clientId) {
      try {
        await this.locked(async () => {
          let value = await this.readCredential(clientId);
          await this.loadCache(clientId, value.login);
          auth = this.publicAuth(value);
          if (!value.token) { await this.clearCache(); return; }
          value = await this.tokenBundle(clientId, value);
          const needed = urls.filter((url) => pullRequestIdentity(url) && (() => {
            const entry = this.cache.get(url);
            return force || !entry || Object.entries(turnsFor(url)).some(([id, turn]) => entry.turns[id] !== turn)
              || ((entry.pr.state === "unknown" || entry.pr.checks === "pending" || entry.pr.checks === "unknown" || (["open", "draft"].includes(entry.pr.state) && (entry.pr.mergeState === "UNKNOWN" || entry.pr.mergeState == null || entry.pr.mergeable === "UNKNOWN"))) && entry.expiresAt <= this.now());
          })())
            .sort((a, b) => (this.cache.get(a)?.expiresAt ?? 0) - (this.cache.get(b)?.expiresAt ?? 0)).slice(0, 25);
          for (let start = 0; start < needed.length; start += 25) {
            const batch = needed.slice(start, start + 25);
            const query = `query { ${batch.map((url, i) => {
              const p = pullRequestIdentity(url);
              return `p${i}: repository(owner:${JSON.stringify(p.owner)},name:${JSON.stringify(p.repo)}) { pullRequest(number:${p.number}) { title state merged isDraft headRefOid mergeable mergeStateStatus } }`;
            }).join(" ")} }`;
            let result;
            try { result = await this.request("https://api.github.com/graphql", { token: value.token, query }); }
            catch (error) {
              for (const url of batch) this.cache.set(url, { expiresAt: this.now() + CACHE_MS, turns: { ...this.cache.get(url)?.turns, ...turnsFor(url) }, pr: { url, state: "unknown", checks: "unknown", ...(error.accessIssue ? { accessIssue: error.accessIssue } : {}), error: error.message } });
              auth = { ...auth, error: error.message };
              if (error.status === 401) { await this.save(clientId, {}); auth.connected = false; await this.clearCache(); break; }
              continue;
            }
            const ciResults = [];
            // Bound CI requests so one batch does not wait for every PR in sequence.
            for (let offset = 0; offset < batch.length; offset += 5) {
              ciResults.push(...await Promise.all(batch.slice(offset, offset + 5).map(async (url, index) => {
                const p = result.data?.[`p${offset + index}`]?.pullRequest;
                if (!p || !["OPEN", "CLOSED", "MERGED"].includes(p.state)) return { checks: "unknown" };
                try { return await this.checks(pullRequestIdentity(url), p.headRefOid, value.token); }
                catch (error) { return { authError: error }; }
              })));
              if (ciResults.some(ci => ci.authError)) break;
            }
            const authError = ciResults.find(ci => ci.authError)?.authError;
            if (authError) {
              if (authError.status === 401) { await this.save(clientId, {}); auth.connected = false; await this.clearCache(); break; }
              throw authError;
            }
            for (const [i, url] of batch.entries()) {
              const p = result.data?.[`p${i}`]?.pullRequest;
              const accessErrors = (result.errors ?? []).filter(error => error.path?.[0] === `p${i}`);
              const accessIssue = accessErrors.some(error => error.type === "FORBIDDEN") ? "denied"
                : !p && accessErrors.some(error => error.type === "NOT_FOUND") ? "not_found" : null;
              const failed = !p || !["OPEN", "CLOSED", "MERGED"].includes(p.state);
              const state = failed || !p ? "unknown" : p.merged === true || p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.state === "OPEN" ? p.isDraft ? "draft" : "open" : "unknown";
              const ci = ciResults[i];
              const { checks } = ci;
              this.cache.set(url, { expiresAt: this.now() + CACHE_MS, turns: { ...this.cache.get(url)?.turns, ...turnsFor(url) }, pr: { url, state, checks, ...(accessIssue || ci.accessIssue ? { accessIssue: accessIssue || ci.accessIssue } : {}), ...(ci.error ? { error: ci.error } : {}), ...(typeof p?.title === "string" ? { title: p.title } : {}), ...(typeof p?.headRefOid === "string" ? { headRevision: p.headRefOid } : {}), mergeState: p?.mergeStateStatus ?? null, mergeable: p?.mergeable ?? "UNKNOWN", hasMergeConflicts: p?.mergeable === "CONFLICTING" || p?.mergeStateStatus === "DIRTY", canMerge: p?.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(p?.mergeStateStatus) && !p?.isDraft, checkedAt: new Date(this.now()).toISOString(), ...(state === "unknown" ? { error: "PR status unavailable. Check the app's repository access." } : {}) } });
            }
          }
          if (needed.length && auth.connected) await this.saveCache(clientId, value.login);
        });
      } catch (error) { auth = { ...auth, connected: false, error: error.message }; this.cache.clear(); }
    } else this.cache.clear();
    const tasks = snapshot.tasks.map((task) => {
      const pullRequests = (task.pullRequests ?? []).map((pr) => this.cache.get(pr.url)?.pr ?? { ...pr, state: "unknown", checks: "unknown", error: pullRequestIdentity(pr.url) ? auth.connected ? "Waiting for the next GitHub check." : "Connect GitHub to read PR status." : "This GitHub host or PR URL is not supported." });
      if (task.observed.lastTurnEvent !== "completed" || task.observed.archive || task.manualDone) return { ...task, pullRequests };
      // A routine completion returns to its schedule regardless of GitHub access or PR state.
      if (task.scheduled && (task.inputSource === "scheduled" || task.manualScheduled)) return {
        ...task, pullRequests, status: "scheduled", statusLabel: "Scheduled",
        summary: task.manualScheduled ? "Latest human turn acknowledged in TaskChef; an active schedule remains." : "Latest scheduled turn ended; an active schedule remains.",
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
