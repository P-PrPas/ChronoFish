// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

describe("accessibility tokens", () => {
  it("keeps strong UI boundaries at 3:1 contrast against white", () => {
    const color = styles.match(/--line-strong:\s*(#[a-f\d]{6})/i)?.[1];
    expect(color).toBeDefined();
    expect(1.05 / (luminance(color!.slice(1)) + 0.05)).toBeGreaterThanOrEqual(3);
    expect(styles).toMatch(/input:focus[^}]+outline:\s*3px solid var\(--primary\)/);
  });
});
