import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export async function resetBrowserState(): Promise<void> {
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("chronofish");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("chronofish IndexedDB is still open"));
  });
}

export function withoutIndexedDB(): void {
  Reflect.deleteProperty(window, "indexedDB");
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
