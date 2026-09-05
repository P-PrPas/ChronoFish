import { expect, test } from "vitest";
import { putQueue, queueCount } from "../src/offline";
import { resetBrowserState } from "./helpers";

test("browser harness keeps IndexedDB available and clears queued writes", async () => {
  const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  localStorage.setItem("chronofish.operator_id", "operator-a");
  localStorage.setItem("chronofish.device_id", "device-a");

  try {
    await putQueue("/batches", { batchCode: "RESET-ME" });
    expect(await queueCount()).toBe(1);

    await resetBrowserState();

    expect(await queueCount()).toBe(0);
  } finally {
    if (online) Object.defineProperty(navigator, "onLine", online);
    else Reflect.deleteProperty(navigator, "onLine");
  }
});
