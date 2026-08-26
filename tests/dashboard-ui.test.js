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
    const clipboardWrites = [];
    const pendingClipboardWrites = [];
    let clipboardMode = "reject";
    globalThis.document = document;
    globalThis.Node = FakeElement;
    globalThis.EventSource = FakeEventSource;
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
    globalThis.fetch = async (url) => {
      if (url === "/api/health") {
        return { ok: true, json: async () => ({ taskchefVersion: "test" }) };
      }
      if (url === `/api/tasks/${taskId}`) {
        return {
          ok: true,
          json: async () => ({
            task: {
              createdAt: timestamp,
              id: taskId,
              instruction: "Address the reported failures safely.",
              meaningfulUpdatedAt: timestamp,
              project: {
                githubRepos: ["https://github.com/acme/app", "https://github.com/acme/api"],
                name: "MarketLake",
                path: "/tmp/marketlake",
              },
              relatedGitHubLinks: [{
                label: "acme/app#12",
                number: "12",
                owner: "acme",
                repository: "app",
                type: "issue",
                url: "https://github.com/acme/app/issues/12",
              }],
              relatedGitHubRepository: "acme/app",
              status: "needs_input",
              threadId,
              title: "Continue MarketLake V1",
              turnId: "turn-one",
              turns: [{
                requestSummary: "Review acme/app#12, not <script>bad()</script>.",
                result: { status: "needs_input", summary: "Confirm #13.", updatedAt: timestamp },
                startedAt: timestamp,
                turnId: "turn-one",
              }],
              updatedAt: timestamp,
              updatedBy: "executor",
            },
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
          githubRepos: ["https://github.com/acme/app", "https://github.com/acme/api"],
          name: "MarketLake",
          path: "/tmp/marketlake",
        },
        relatedGitHubLinks: [
          {
            label: "acme/app",
            owner: "acme",
            repository: "app",
            type: "repository",
            url: "https://github.com/acme/app",
          },
          {
            label: "acme/app#11",
            number: "11",
            owner: "acme",
            repository: "app",
            type: "issue",
            url: "https://github.com/acme/app/issues/11",
          },
          {
            label: "acme/app#11",
            number: "11",
            owner: "acme",
            repository: "app",
            type: "pull",
            url: "https://github.com/acme/app/pull/11",
          },
          {
            label: "acme/app#12",
            number: "12",
            owner: "acme",
            repository: "app",
            type: "pull",
            url: "https://github.com/acme/app/pull/12",
          },
          {
            label: "acme/api#20",
            number: "20",
            owner: "acme",
            repository: "api",
            type: "pull",
            url: "https://github.com/acme/api/pull/20",
          },
          {
            label: "acme/api#21",
            number: "21",
            owner: "acme",
            repository: "api",
            type: "issue",
            url: "https://github.com/acme/api/issues/21",
          },
          {
            label: "acme/api#22",
            number: "22",
            owner: "acme",
            repository: "api",
            type: "generic",
            url: "https://github.com/acme/api/issues/22",
          },
        ],
        relatedGitHubRepository: "acme/app",
        latestTurn: {
          requestSummary: "Review https://github.com/acme/app/pull/12 and https://example.com/docs?q=one, not <script>bad()</script>.",
          result: {
            status: "needs_input",
            summary: "Confirm https://github.com/acme/app/issues/12.",
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
    assert.equal(project.children[2].textContent, "acme/app");
    assert.equal(project.children[2].href, "https://github.com/acme/app");
    assert.equal(project.children[2].target, "_blank");
    assert.equal(project.children[2].rel, "noopener noreferrer");
    const relatedLinks = firstCard.children[3];
    assert.equal(relatedLinks.children.length, 5);
    const [
      relatedLink,
      repeatedRepositoryLink,
      secondRepositoryLink,
      secondRepositoryIssue,
      untypedReference,
    ] = relatedLinks.children;
    assert.equal(relatedLink.textContent, "Issue acme/app#11");
    assert.equal(repeatedRepositoryLink.textContent, "PR #12");
    assert.equal(secondRepositoryLink.textContent, "PR acme/api#20");
    assert.equal(secondRepositoryIssue.textContent, "Issue #21");
    assert.equal(untypedReference.textContent, "#22");
    assert.match(
      repeatedRepositoryLink.getAttribute("aria-label"),
      /^PR acme\/app#12, GitHub pull request/,
    );
    assert.match(
      secondRepositoryIssue.getAttribute("aria-label"),
      /^Issue acme\/api#21, GitHub issue/,
    );
    assert.match(untypedReference.getAttribute("aria-label"), /^acme\/api#22 on GitHub/);
    assert.equal(relatedLink.target, "_blank");
    assert.equal(relatedLink.rel, "noopener noreferrer");
    assert.match(relatedLink.getAttribute("aria-label"), /GitHub issue.*opens in a new tab/);
    let propagationStopped = false;
    relatedLink.emit("click", { stopPropagation() { propagationStopped = true; } });
    assert.equal(propagationStopped, true);

    const cardSummary = firstCard.children[2];
    const cardRequest = cardSummary.children[1];
    const cardResult = cardSummary.children[3];
    assert.equal(cardRequest.children[1].textContent, "PR acme/app#12");
    assert.equal(cardRequest.children[3].textContent, "https://example.com/docs?q=one");
    assert.equal(cardResult.children[1].textContent, "Issue acme/app#12");
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
    assert.equal(elements.get("#dialog-related-links").children[0].textContent, "Issue acme/app#12");
    assert.equal(elements.get("#dialog-project").children[0].textContent, "MarketLake");
    assert.equal(elements.get("#dialog-project").children[2].textContent, "acme/app");
    const [latestTurn] = elements.get("#dialog-results").children;
    const request = latestTurn.children[2];
    const result = latestTurn.children[4];
    assert.equal(request.children[1].textContent, "acme/app#12");
    assert.equal(request.children.map(({ textContent }) => textContent).join(""),
      "Review acme/app#12, not <script>bad()</script>.");
    assert.equal(result.children[1].textContent, "acme/app#13");
    assert.equal(result.children[1].className, "github-link");
    assert.match(result.children[1].getAttribute("aria-label"), /on GitHub.*opens in a new tab/);
    assert.equal(request.children.some(({ tagName }) => tagName === "SCRIPT"), false);

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
  } finally {
    globalThis.clearInterval = previous.clearInterval;
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
