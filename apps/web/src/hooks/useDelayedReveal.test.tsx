import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useDelayedReveal } from "./useDelayedReveal";

// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

function Probe(props: {
  readonly value: string | null;
  readonly delayMs: number;
  readonly record: (phase: string | null) => void;
}) {
  const phase = useDelayedReveal(props.value, props.delayMs);
  const lastRef = useRef<string | null | undefined>(undefined);
  if (lastRef.current !== phase) {
    lastRef.current = phase;
    props.record(phase);
  }
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDelayedReveal", () => {
  it("holds the value back until it has been present for the whole delay", async () => {
    vi.useFakeTimers();
    const document = installTestDom();
    const root = createRoot(document.createElement("div") as unknown as Element);
    const phases: Array<string | null> = [];

    try {
      await act(() =>
        root.render(<Probe value="syncing" delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      expect(phases).toEqual([null]);

      await act(() => vi.advanceTimersByTimeAsync(499));
      expect(phases).toEqual([null]);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(phases).toEqual([null, "syncing"]);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("never reveals a value that resolves within the delay", async () => {
    vi.useFakeTimers();
    const document = installTestDom();
    const root = createRoot(document.createElement("div") as unknown as Element);
    const phases: Array<string | null> = [];

    try {
      await act(() =>
        root.render(<Probe value="syncing" delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      await act(() =>
        root.render(<Probe value={null} delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      await act(() => vi.advanceTimersByTimeAsync(1_000));

      expect(phases).toEqual([null]);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("reveals the latest label when it changes while waiting", async () => {
    vi.useFakeTimers();
    const document = installTestDom();
    const root = createRoot(document.createElement("div") as unknown as Element);
    const phases: Array<string | null> = [];

    try {
      await act(() =>
        root.render(<Probe value="loading" delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      await act(() =>
        root.render(<Probe value="syncing" delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      await act(() => vi.advanceTimersByTimeAsync(500));

      expect(phases).toEqual([null, "syncing"]);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("hides immediately when a revealed value goes away", async () => {
    vi.useFakeTimers();
    const document = installTestDom();
    const root = createRoot(document.createElement("div") as unknown as Element);
    const phases: Array<string | null> = [];

    try {
      await act(() =>
        root.render(<Probe value="syncing" delayMs={500} record={(phase) => phases.push(phase)} />),
      );
      await act(() => vi.advanceTimersByTimeAsync(500));
      await act(() =>
        root.render(<Probe value={null} delayMs={500} record={(phase) => phases.push(phase)} />),
      );

      expect(phases).toEqual([null, "syncing", null]);
    } finally {
      await act(() => root.unmount());
    }
  });
});
