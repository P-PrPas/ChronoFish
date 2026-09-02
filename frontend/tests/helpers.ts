import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

export type FetchHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export function resetBrowserState(): void {
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase("chronofish");
}

export function stubFetch(routes: Record<string, FetchHandler | Response>) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin);
    const handler = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
    if (!handler) throw new Error(`Unexpected fetch: ${url.pathname}${url.search}`);
    return handler instanceof Response ? handler.clone() : handler(url, init);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

export async function renderPage(
  node: ReactNode,
): Promise<{ element: HTMLDivElement; root: Root; unmount: () => Promise<void> }> {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(node));
  return {
    element,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}
