// @vitest-environment node
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { serviceWorkerSource } from "../src/service-worker";

const source = serviceWorkerSource(["/", "/manifest.webmanifest", "/assets/app.js"]);

test("service worker leaves API requests to the network", async () => {
  type FetchEvent = { request: Request; respondWith: (response: unknown) => void };
  let onFetch: ((event: FetchEvent) => void) | undefined;
  const self = {
    location: { origin: "http://localhost" },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === "fetch") onFetch = listener as (event: FetchEvent) => void;
    },
  };

  runInNewContext(source, { self, URL, Response, fetch, caches: {} });
  expect(onFetch).toBeTypeOf("function");
  const respondWith = vi.fn();
  onFetch!({ request: new Request("http://localhost/api/v1/health"), respondWith });
  expect(respondWith).not.toHaveBeenCalled();
});

test("service worker prefers the deployed shell for online navigation", async () => {
  type FetchEvent = { request: Request; respondWith: (response: Promise<Response>) => void };
  let onFetch: ((event: FetchEvent) => void) | undefined;
  const self = {
    location: { origin: "http://localhost" },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === "fetch") onFetch = listener as (event: FetchEvent) => void;
    },
  };
  const cache = { put: vi.fn() };
  const caches = {
    match: vi.fn(async () => new Response("stale shell")),
    open: vi.fn(async () => cache),
  };
  const fetch = vi.fn(async () => new Response("deployed shell"));
  let response: Promise<Response> | undefined;

  runInNewContext(source, { self, URL, Response, fetch, caches });
  onFetch!({
    request: { method: "GET", mode: "navigate", url: "http://localhost/" } as Request,
    respondWith(value) {
      response = value;
    },
  });

  expect(await response?.then((value) => value.text())).toBe("deployed shell");
  expect(fetch).toHaveBeenCalledOnce();
});
