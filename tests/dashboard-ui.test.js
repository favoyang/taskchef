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
    this.listeners.get(type)?.(event);
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
    globalThis.document = document;
    globalThis.Node = FakeElement;
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = async (url) => {
      if (url === "/api/health") {
        return { ok: true, json: async () => ({ taskchefVersion: "test" }) };
      }
      if (url === "/api/tasks/task-one") {
        return {
          ok: true,
          json: async () => ({
            task: {
              createdAt: timestamp,
              id: "task-one",
              instruction: "Address the reported failures safely.",
              meaningfulUpdatedAt: timestamp,
              project: {
                githubRepos: ["https://github.com/acme/app", "https://github.com/acme/api"],
                name: "MarketLake",
                path: "/tmp/marketlake",
              },
              relatedGitHubLinks: [{
                label: "#12",
                url: "https://github.com/acme/app/issues/12",
              }],
              relatedGitHubRepository: null,
              status: "needs_input",
              threadId: "thread-one",
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
        id: "task-one",
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
        relatedGitHubLinks: [{
          label: "Issue #11",
          url: "https://github.com/acme/app/issues/11",
        }],
        relatedGitHubRepository: "acme/app",
        status: "needs_input",
        threadId: "thread-one",
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

    const [firstCard] = elements.get("#task-list").children;
    const relatedLinks = firstCard.children[3];
    const [relatedLink] = relatedLinks.children;
    assert.equal(relatedLink.textContent, "Issue #11");
    assert.equal(relatedLink.target, "_blank");
    assert.equal(relatedLink.rel, "noopener noreferrer");
    assert.match(relatedLink.getAttribute("aria-label"), /opens in a new tab/);
    let propagationStopped = false;
    relatedLink.emit("click", { stopPropagation() { propagationStopped = true; } });
    assert.equal(propagationStopped, true);

    firstCard.children[0].children[0].emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(elements.get("#dialog-related-links").children[0].textContent, "#12");
    const [latestTurn] = elements.get("#dialog-results").children;
    const request = latestTurn.children[2];
    const result = latestTurn.children[4];
    assert.equal(request.children[1].textContent, "acme/app#12");
    assert.equal(request.children.map(({ textContent }) => textContent).join(""),
      "Review acme/app#12, not <script>bad()</script>.");
    assert.equal(result.children[1].textContent, "#13");
    assert.equal(result.children[1].className, "github-reference-ambiguous");
    assert.equal(result.children[1].tabIndex, 0);
    assert.match(result.children[1].getAttribute("aria-label"), /repository is ambiguous/);
    assert.equal(request.children.some(({ tagName }) => tagName === "SCRIPT"), false);

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
    globalThis.Node = previous.Node;
    globalThis.setInterval = previous.setInterval;
  }
});
