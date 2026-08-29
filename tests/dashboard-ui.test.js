import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.classList = { add() {}, toggle() {} };
    this.dataset = {};
    this.hidden = false;
    this.isConnected = true;
    this.open = false;
    this.textContent = "";
    this.value = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, event = { target: this }) {
    return this.listeners.get(type)?.(event);
  }

  append(...children) {
    this.children.push(...children);
  }

  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    this.focused = true;
  }

  querySelector(selector) {
    if (selector === "input:checked") return this.inputs?.find(({ checked }) => checked) ?? null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-status-label]") return this.statusLabels ?? [];
    if (selector === 'input[name="status-filter"]') return this.inputs ?? [];
    return [];
  }
}

class FakeEventSource {
  constructor() {
    this.listeners = new Map();
    FakeEventSource.instance = this;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, data) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

test("dashboard renders a live notification with time and shared accessible description", async () => {
  const previous = {
    clearInterval: globalThis.clearInterval,
    confirm: globalThis.confirm,
    document: globalThis.document,
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    setInterval: globalThis.setInterval,
  };
  const elements = new Map();
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode(text) {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
    querySelector(selector) {
      if (!elements.has(selector)) {
        const element = new FakeElement();
        if (selector === "#status-filter") {
          const values = ["", "working", "needs input", "completed", "failed"];
          element.inputs = values.map((value, index) => ({
            checked: index === 0,
            focus() {},
            name: "status-filter",
            value,
          }));
          element.statusLabels = values.map((statusLabel) => {
            const label = new FakeElement("span");
            label.dataset.statusLabel = statusLabel;
            return label;
          });
        }
        if (selector === "#date-filter") element.value = "all";
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
  };
  try {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const threadId = "019ffb69-57a6-7801-8b7a-8ff4c32a398c";
    const relatedGitHubLinksFixture = [
      ["marketlake", "34", "pull"],
      ["guzuoshou-workspace", "124", "issue"],
      ["marketlake", "25", "issue"],
      ["guzuoshou-workspace", "109", "pull"],
      ["marketlake", "32", "generic"],
      ["guzuoshou-workspace", "108", "issue"],
      ["guzuoshou-workspace", "115", "issue"],
      ["guzuoshou-workspace", "112", "pull"],
      ["guzuoshou-workspace", "114", "issue"],
      ["guzuoshou-workspace", "118", "pull"],
      ["marketlake", "25", "pull"],
    ].map(([repository, number, type]) => ({
      label: `acme/${repository}#${number}`,
      number,
      owner: "acme",
      repository,
      type,
      url: `https://github.com/acme/${repository}/${type === "pull" ? "pull" : "issues"}/${number}`,
    }));
    const clipboardWrites = [];
    const archiveRequests = [];
    const pendingArchiveRequests = [];
    const manualRequests = [];
    const pendingClipboardWrites = [];
    let clipboardMode = "reject";
    let manualCompletedTask = null;
    let manualTransitionSucceeds = false;
    globalThis.document = document;
    globalThis.Node = FakeElement;
    globalThis.EventSource = FakeEventSource;
    globalThis.confirm = () => true;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (value) => {
        if (clipboardMode === "reject") throw new Error("clipboard denied");
        if (clipboardMode === "defer") {
          await new Promise((resolve) => pendingClipboardWrites.push({ resolve, value }));
        }
        clipboardWrites.push(value);
      } } },
    });
    globalThis.fetch = async (url, options) => {
      if (url === "/api/health") {
        return { ok: true, json: async () => ({ taskchefVersion: "test" }) };
      }
      if (url === `/api/tasks/${taskId}`) {
        if (manualCompletedTask) {
          return { ok: true, json: async () => ({ task: manualCompletedTask }) };
        }
        return {
          ok: true,
          json: async () => ({
            task: {
              createdAt: timestamp,
              id: taskId,
              instruction: "Address the reported failures safely.",
              meaningfulUpdatedAt: timestamp,
              project: {
                githubRepos: [
                  "https://github.com/acme/marketlake",
                  "https://github.com/acme/guzuoshou-workspace",
                ],
                name: "MarketLake",
                path: "/tmp/marketlake",
              },
              relatedGitHubLinks: relatedGitHubLinksFixture,
              relatedGitHubRepository: null,
              status: "needs_input",
              threadId,
              title: "Continue MarketLake V1",
              turnId: "turn-one",
              usage: {
                status: "available",
                task: {
                  status: "available",
                  inputTokens: 100,
                  cachedInputTokens: 200,
                  outputTokens: 30,
                  reasoningOutputTokens: 10,
                  totalTokens: 330,
                  estimatedCostUsd: 0.12,
                  provenance: { provider: "ccusage", version: "20.0.14" },
                  sampledAt: timestamp,
                  sourceUpdatedAt: timestamp,
                },
                turns: {
                  "turn-one": {
                    status: "available",
                    inputTokens: 100,
                    cachedInputTokens: 200,
                    outputTokens: 30,
                    reasoningOutputTokens: 10,
                    totalTokens: 330,
                    estimatedCostUsd: 0.12,
                  },
                },
              },
              turns: [{
                requestSummary: "Review https://github.com/acme/marketlake/issues/25, not <script>bad()</script>.",
                result: {
                  status: "needs_input",
                  summary: "Confirm https://github.com/acme/marketlake/issues/32.",
                  updatedAt: timestamp,
                },
                startedAt: timestamp,
                turnId: "turn-one",
              }],
              updatedAt: timestamp,
              updatedBy: "executor",
            },
          }),
        };
      }
      if (url === `/api/tasks/${taskId}/archive-codex`) {
        archiveRequests.push({ url, options });
        await new Promise((resolve) => pendingArchiveRequests.push(resolve));
        return {
          ok: true,
          json: async () => ({
            message: "Archived the Codex chat. TaskChef history remains available.",
            status: "archived",
          }),
        };
      }
      if (url === `/api/tasks/${taskId}/manual-transition`) {
        manualRequests.push({ url, options });
        if (manualTransitionSucceeds) {
          const manualUpdatedAt = new Date(Date.parse(timestamp) + 1_000).toISOString();
          manualCompletedTask = {
            createdAt: timestamp,
            id: taskId,
            instruction: "Address the reported failures safely.",
            latestTurn: {
              provenance: { kind: "dashboard_manual" },
              requestSummary: "Manual dashboard transition from needs_input to completed.",
              result: {
                status: "completed",
                summary: "Manually marked completed from the TaskChef dashboard.",
                updatedAt: manualUpdatedAt,
              },
              startedAt: manualUpdatedAt,
              turnId: null,
              turnRef: "8f7d8e68-c72c-4a3f-9ef0-10409e22b482",
            },
            meaningfulUpdatedAt: manualUpdatedAt,
            project: {
              githubRepos: ["https://github.com/acme/marketlake"],
              name: "MarketLake",
              path: "/tmp/marketlake",
            },
            status: "completed",
            summary: "Manually marked completed from the TaskChef dashboard.",
            threadId,
            title: "Continue MarketLake V1",
            turnId: null,
            turnRef: "8f7d8e68-c72c-4a3f-9ef0-10409e22b482",
            updatedAt: manualUpdatedAt,
            updatedBy: "dashboard",
          };
          FakeEventSource.instance.emit("snapshot", {
            healthy: true,
            tasks: [manualCompletedTask],
          });
          return {
            ok: true,
            json: async () => ({
              idempotent: false,
              task: manualCompletedTask,
            }),
          };
        }
        return {
          ok: false,
          json: async () => ({
            code: "dashboard_error",
            message: "Preview transition failed.",
          }),
        };
      }
      if (url === "/api/tasks/task-two") return { ok: false };
      throw new Error(`Unexpected fetch: ${url}`);
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    await import(`../src/dashboard/app.js?dashboard-ui=${Date.now()}`);

    FakeEventSource.instance.emit("snapshot", { healthy: true, tasks: [] });
    FakeEventSource.instance.emit("dashboard-error", {
      message: "The task log is temporarily unavailable. Showing the last valid snapshot.",
    });
    assert.equal(elements.get("#dashboard-message").hidden, false);
    assert.equal(
      elements.get("#dashboard-message-text").textContent,
      "The task log is temporarily unavailable. Showing the last valid snapshot.",
    );
    FakeEventSource.instance.emit("snapshot", { healthy: true, tasks: [] });
    assert.equal(elements.get("#dashboard-message").hidden, true);
    const timestamp = new Date().toISOString();
    FakeEventSource.instance.emit("snapshot", {
      healthy: true,
      tasks: [{
        createdAt: timestamp,
        id: taskId,
        instruction: "Continue the import",
        lastResult: {
          status: "needs_input",
          summary: "Choose the source archive.",
          turnId: "turn-one",
          updatedAt: timestamp,
        },
        meaningfulUpdatedAt: timestamp,
        project: {
          githubRepos: [
            "https://github.com/acme/marketlake",
            "https://github.com/acme/guzuoshou-workspace",
          ],
          name: "MarketLake",
          path: "/tmp/marketlake",
        },
        relatedGitHubLinks: relatedGitHubLinksFixture,
        relatedGitHubRepository: null,
        latestTurn: {
          requestSummary: "Review https://github.com/acme/marketlake/pull/34 and https://example.com/docs?q=one, not <script>bad()</script>.",
          result: {
            status: "needs_input",
            summary: "Confirm https://github.com/acme/marketlake/issues/25.",
            updatedAt: timestamp,
          },
          startedAt: timestamp,
          turnId: "turn-one",
        },
        status: "needs_input",
        threadId,
        title: "Continue MarketLake V1",
        turnId: "turn-one",
        updatedAt: timestamp,
        updatedBy: "executor",
      }, {
        createdAt: timestamp,
        id: "task-two",
        instruction: "Keep working",
        meaningfulUpdatedAt: timestamp,
        project: { name: "MarketLake", path: "/tmp/marketlake" },
        status: "working",
        threadId: "thread-two",
        title: "Continue MarketLake V2",
        turnId: "turn-two",
        updatedAt: timestamp,
        updatedBy: "executor",
      }],
    });

    const [toast] = elements.get("#toast-list").children;
    const [open, dismiss] = toast.children;
    const metadata = open.children.at(-1);
    const [time] = metadata.children;
    assert.equal(time.textContent, "just now");
    assert.match(elements.get("#notification-announcer").textContent, /just now/);
    assert.equal(
      dismiss.getAttribute("aria-describedby"),
      open.getAttribute("aria-describedby"),
    );

    const [firstCard, secondCard] = elements.get("#task-list").children;
    const project = firstCard.children[1];
    assert.equal(project.children[0].textContent, "MarketLake");
    const relatedLinks = firstCard.children[3];
    assert.equal(relatedLinks.children.length, 2);
    assert.equal(relatedLinks.children[0].className, "github-links-group");
    assert.equal(relatedLinks.children[1].className, "github-links-group");
    const [
      relatedLink,
      repeatedRepositoryLink,
      thirdRepositoryLink,
    ] = relatedLinks.children[0].children;
    const [
      secondRepositoryLink,
      secondRepositoryIssue,
      untypedReference,
      ...remainingSecondRepositoryLinks
    ] = relatedLinks.children[1].children;
    assert.deepEqual(
      relatedLinks.children[0].children.map(({ textContent }) => textContent),
      ["marketlake #25", "#32", "#34"],
    );
    assert.deepEqual(
      relatedLinks.children[1].children.map(({ textContent }) => textContent),
      ["guzuoshou-workspace #108", "#109", "#112", "#114", "#115", "#118", "#124"],
    );
    assert.match(
      thirdRepositoryLink.getAttribute("aria-label"),
      /^acme\/marketlake PR #34, GitHub pull request/,
    );
    assert.match(
      secondRepositoryLink.getAttribute("aria-label"),
      /^acme\/guzuoshou-workspace Issue #108, GitHub issue/,
    );
    assert.match(untypedReference.getAttribute("aria-label"), /^acme\/guzuoshou-workspace PR #112/);
    assert.equal(repeatedRepositoryLink.href, "https://github.com/acme/marketlake/issues/32");
    assert.equal(thirdRepositoryLink.href, "https://github.com/acme/marketlake/pull/34");
    assert.equal(secondRepositoryIssue.href, "https://github.com/acme/guzuoshou-workspace/pull/109");
    assert.equal(remainingSecondRepositoryLinks.at(-1).href,
      "https://github.com/acme/guzuoshou-workspace/issues/124");
    assert.equal(relatedLink.target, "_blank");
    assert.equal(relatedLink.rel, "noopener noreferrer");
    assert.match(relatedLink.getAttribute("aria-label"), /GitHub issue.*opens in a new tab/);
    let propagationStopped = false;
    relatedLink.emit("click", { stopPropagation() { propagationStopped = true; } });
    assert.equal(propagationStopped, true);

    const cardSummary = firstCard.children[2];
    const cardRequest = cardSummary.children[1];
    const cardResult = cardSummary.children[3];
    assert.equal(cardRequest.children[1].textContent, "marketlake PR #34");
    assert.equal(cardRequest.children[3].textContent, "https://example.com/docs?q=one");
    assert.equal(cardResult.children[1].textContent, "marketlake Issue #25");
    assert.match(cardRequest.children[1].getAttribute("aria-label"), /GitHub pull request/);
    assert.match(cardResult.children[1].getAttribute("aria-label"), /GitHub issue/);
    assert.notEqual(
      cardRequest.children[1].getAttribute("aria-label"),
      cardResult.children[1].getAttribute("aria-label"),
    );
    assert.equal(cardRequest.children.some(({ tagName }) => tagName === "SCRIPT"), false);
    for (const anchor of [cardRequest.children[1], cardRequest.children[3], cardResult.children[1]]) {
      assert.equal(anchor.target, "_blank");
      assert.equal(anchor.rel, "noopener noreferrer");
      assert.match(anchor.getAttribute("aria-label"), /opens in a new tab/);
      let cardPropagationStopped = false;
      anchor.emit("click", { stopPropagation() { cardPropagationStopped = true; } });
      assert.equal(cardPropagationStopped, true);
    }

    firstCard.children[0].children[0].emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(elements.get("#dialog-related-links").children.length, 2);
    assert.deepEqual(
      elements.get("#dialog-related-links").children.map((group) => (
        group.children.map(({ textContent }) => textContent)
      )),
      [
        ["marketlake #25", "#32", "#34"],
        ["guzuoshou-workspace #108", "#109", "#112", "#114", "#115", "#118", "#124"],
      ],
    );
    assert.equal(elements.get("#dialog-project").children[0].textContent, "MarketLake");
    const [latestTurn] = elements.get("#dialog-results").children;
    const request = latestTurn.children[2];
    const result = latestTurn.children[4];
    assert.equal(request.children[1].textContent, "marketlake Issue #25");
    assert.equal(request.children.map(({ textContent }) => textContent).join(""),
      "Review marketlake Issue #25, not <script>bad()</script>.");
    assert.equal(result.children[1].textContent, "marketlake Issue #32");
    assert.equal(result.children[1].className, "github-link");
    assert.match(result.children[1].getAttribute("aria-label"), /GitHub issue.*opens in a new tab/);
    assert.equal(request.children.some(({ tagName }) => tagName === "SCRIPT"), false);
    const turnUsage = latestTurn.children[5];
    assert.equal(turnUsage.children[0].textContent, "330 tokens · estimated $0.12");
    const taskUsage = elements.get("#dialog-usage").children[0];
    assert.equal(taskUsage.children[0].textContent, "330 tokens · estimated $0.12");
    assert.match(taskUsage.children[2].textContent, /Source: ccusage 20\.0\.14/);
    assert.match(taskUsage.children[2].textContent, /API-equivalent estimate/);

    const moreTaskActions = elements.get("#more-task-actions");
    const manualPanel = elements.get("#manual-transition-panel");
    assert.equal(moreTaskActions.textContent, "…");
    assert.equal(moreTaskActions.getAttribute("aria-label"), "More task actions");
    moreTaskActions.emit("click");
    assert.equal(moreTaskActions.getAttribute("aria-expanded"), "true");
    assert.equal(moreTaskActions.textContent, "←");
    assert.equal(moreTaskActions.getAttribute("aria-label"), "Hide more task actions");
    assert.equal(manualPanel.hidden, false);
    assert.equal(elements.get("#copy-task-id").hidden, false);
    assert.equal(elements.get("#mark-task-completed").hidden, false);
    assert.equal(elements.get("#mark-task-failed").hidden, false);
    const markFailed = elements.get("#mark-task-failed");
    await markFailed.emit("click", {
      currentTarget: markFailed,
      stopPropagation() {},
    });
    assert.equal(manualRequests.length, 1);
    assert.equal(manualRequests[0].url, `/api/tasks/${taskId}/manual-transition`);
    assert.equal(JSON.parse(manualRequests[0].options.body).targetStatus, "failed");
    assert.equal(elements.get("#manual-transition-error").textContent, "Preview transition failed.");

    const archiveTask = elements.get("#archive-codex");
    assert.equal(archiveTask.hidden, true);
    assert.equal(archiveTask.disabled, false);
    assert.equal(archiveTask.textContent, "Archive chat");
    await archiveTask.emit("click", {
      currentTarget: archiveTask,
      stopPropagation() {},
    });
    assert.deepEqual(archiveRequests, []);
    assert.equal(archiveTask.hidden, true);
    assert.equal(archiveTask.textContent, "Archive chat");
    moreTaskActions.emit("click");
    moreTaskActions.emit("click");
    assert.equal(archiveTask.hidden, true);
    await archiveTask.emit("click", {
      currentTarget: archiveTask,
      stopPropagation() {},
    });
    assert.equal(archiveRequests.length, 0);
    assert.equal(archiveTask.textContent, "Archive chat");
    assert.equal(moreTaskActions.textContent, "←");

    const copyTaskId = elements.get("#copy-task-id");
    assert.equal(copyTaskId.textContent, "Copy Task ID");
    assert.equal(copyTaskId.getAttribute("aria-label"), "Copy Task ID");
    await copyTaskId.emit("click");
    assert.deepEqual(clipboardWrites, []);
    assert.equal(copyTaskId.textContent, "Copy Task ID");
    assert.equal(
      elements.get("#dashboard-message-text").textContent,
      "Clipboard access is unavailable. Copy the Task ID from the metadata below.",
    );
    clipboardMode = "defer";
    const staleCopy = copyTaskId.emit("click");
    secondCard.children[0].children[0].emit("click");
    pendingClipboardWrites.shift().resolve();
    await staleCopy;
    assert.equal(copyTaskId.textContent, "Copy Task ID");
    assert.equal(copyTaskId.getAttribute("aria-label"), "Copy Task ID");

    firstCard.children[0].children[0].emit("click");
    const olderCopy = copyTaskId.emit("click");
    const latestCopy = copyTaskId.emit("click");
    pendingClipboardWrites.shift().resolve();
    await olderCopy;
    assert.equal(copyTaskId.textContent, "Copy Task ID");
    pendingClipboardWrites.shift().resolve();
    await latestCopy;
    assert.deepEqual(clipboardWrites, [taskId, taskId, taskId]);
    assert.notEqual(clipboardWrites[0], threadId);
    assert.equal(copyTaskId.textContent, "Task ID copied");
    assert.equal(copyTaskId.getAttribute("aria-label"), "Task ID copied");

    const statusFilter = elements.get("#status-filter");
    assert.deepEqual(
      statusFilter.statusLabels.map(({ textContent }) => textContent),
      ["All (2)", "Working (1)", "Needs input (1)", "Completed", "Failed"],
    );
    statusFilter.inputs[0].checked = false;
    statusFilter.inputs[2].checked = true;
    statusFilter.emit("change");
    assert.equal(elements.get("#task-list").children.length, 1);
    assert.match(elements.get("#task-count").textContent, /^1 of 2 tasks$/);
    let prevented = false;
    statusFilter.emit("keydown", {
      key: "ArrowRight",
      preventDefault() { prevented = true; },
      target: statusFilter.inputs[2],
    });
    assert.equal(prevented, true);
    assert.equal(statusFilter.inputs[3].checked, true);
    assert.equal(elements.get("#task-list").children.length, 0);

    const dashboardMessageBeforeManualSuccess = {
      hidden: elements.get("#dashboard-message").hidden,
      text: elements.get("#dashboard-message-text").textContent,
    };
    manualTransitionSucceeds = true;
    const markCompleted = elements.get("#mark-task-completed");
    await markCompleted.emit("click", {
      currentTarget: markCompleted,
      stopPropagation() {},
    });
    assert.equal(manualRequests.length, 2);
    assert.equal(JSON.parse(manualRequests[1].options.body).targetStatus, "completed");
    assert.deepEqual({
      hidden: elements.get("#dashboard-message").hidden,
      text: elements.get("#dashboard-message-text").textContent,
    }, dashboardMessageBeforeManualSuccess);
    assert.match(
      elements.get("#notification-announcer").textContent,
      /Task manually completed.*Manually marked completed from the TaskChef dashboard\./,
    );
    const manualCompletionToast = elements.get("#toast-list").children.find((toast) => (
      toast.children[0]?.children[0]?.textContent === "Task manually completed"
    ));
    assert.ok(manualCompletionToast);
    assert.equal(
      manualCompletionToast.children[0].children[2].textContent,
      "Manually marked completed from the TaskChef dashboard.",
    );
    assert.equal(elements.get("#task-list").children.length, 1);
  } finally {
    globalThis.clearInterval = previous.clearInterval;
    globalThis.confirm = previous.confirm;
    globalThis.document = previous.document;
    globalThis.EventSource = previous.EventSource;
    globalThis.fetch = previous.fetch;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previous.navigator,
    });
    globalThis.Node = previous.Node;
    globalThis.setInterval = previous.setInterval;
  }
});
