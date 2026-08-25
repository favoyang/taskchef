import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.classList = { add() {}, toggle() {} };
    this.hidden = false;
    this.isConnected = true;
    this.open = false;
    this.textContent = "";
    this.value = "";
  }

  addEventListener() {}

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
    Node: globalThis.Node,
    setInterval: globalThis.setInterval,
  };
  const elements = new Map();
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
  };
  try {
    globalThis.document = document;
    globalThis.Node = FakeElement;
    globalThis.EventSource = FakeEventSource;
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
        project: { name: "MarketLake", path: "/tmp/marketlake" },
        status: "needs_input",
        threadId: "thread-one",
        title: "Continue MarketLake V1",
        turnId: "turn-one",
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
  } finally {
    globalThis.clearInterval = previous.clearInterval;
    globalThis.document = previous.document;
    globalThis.EventSource = previous.EventSource;
    globalThis.Node = previous.Node;
    globalThis.setInterval = previous.setInterval;
  }
});
