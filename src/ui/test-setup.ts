import "@testing-library/jest-dom/vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
});

Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? false : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});

Object.defineProperty(globalThis.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value() {},
});

Object.defineProperty(globalThis.CSS, "escape", {
  configurable: true,
  value: (value: string) => value.replaceAll('"', '\\"'),
});
