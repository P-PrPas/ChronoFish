import "fake-indexeddb/auto";
import { afterEach, beforeEach, vi } from "vitest";
import { resetBrowserState } from "./helpers";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const reportError = console.error.bind(console);

beforeEach(() => {
  if (typeof window !== "undefined") {
    resetBrowserState();
    delete (window as Partial<Window>).indexedDB;
  }
  vi.stubGlobal("console", {
    ...console,
    error: (...args: unknown[]) => {
      if (String(args[0]).includes("act(")) return;
      reportError(...args);
    },
  });
});

afterEach(() => vi.unstubAllGlobals());
