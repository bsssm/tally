import { describe, expect, it } from "vitest";
import { redact, TallyError, toSafeError } from "./redact.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef";

describe("redact", () => {
  it("masks a known secret wherever it appears", () => {
    const out = redact(`failed: ${KEY} and again ${KEY}`, [KEY]);
    expect(out).not.toContain(KEY);
    expect(out).toContain("sk-o…cdef");
  });
  it("masks secrets by pattern even when not listed", () => {
    expect(redact(`Authorization: Bearer ${KEY}`)).not.toContain(KEY);
    expect(redact(`x sk-ant-api03-abcdefghijklmnopqrstuvwxyz y`)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
  it("TallyError and toSafeError never carry the secret", () => {
    const e = new TallyError("http", `HTTP 500 body=${KEY}`, `retry with ${KEY}`, [KEY]);
    expect(e.message).not.toContain(KEY);
    expect(e.hint).not.toContain(KEY);
    const s = toSafeError(new Error(`boom ${KEY}`), [KEY]);
    expect(s.message).not.toContain(KEY);
  });
});
