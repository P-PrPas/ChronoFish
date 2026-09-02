const hex = (value: number) => value.toString(16).padStart(2, "0");
const randomBytes = (bytes: Uint8Array) => {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(bytes);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
};

export function uuidv7(now = Date.now(), random: (bytes: Uint8Array) => Uint8Array = randomBytes): string {
  const bytes = random(new Uint8Array(16));
  const timestamp = BigInt(Math.max(0, Math.floor(now)));
  for (let index = 5; index >= 0; index -= 1) bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${Array.from(bytes.slice(0, 4), hex).join("")}-${Array.from(bytes.slice(4, 6), hex).join("")}-${Array.from(bytes.slice(6, 8), hex).join("")}-${Array.from(bytes.slice(8, 10), hex).join("")}-${Array.from(bytes.slice(10), hex).join("")}`;
}
