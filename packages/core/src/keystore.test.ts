import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { masterKeyExists, openKeystore, PassphraseKeySource } from "./keystore.js";

/** The keystore must stay silent on first run: no master key until `connect` asks for one. */
describe("keystore", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const vars = ["TALLY_HOME", "TALLY_MASTER_KEY", "TALLY_KEY_SOURCE", "TALLY_PASSPHRASE"];

  beforeEach(() => {
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    home = mkdtempSync(join(tmpdir(), "tally-ks-"));
    process.env.TALLY_HOME = home;
  });
  afterEach(() => {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("reports no master key on a fresh store and does not create one when create=false", async () => {
    expect(masterKeyExists()).toBe(false);
    let asked = 0;
    await expect(
      openKeystore({ create: false, askPassphrase: async () => (asked++, "correct horse battery") }),
    ).rejects.toMatchObject({ code: "no-master-key" });
    expect(asked).toBe(0);
    expect(existsSync(join(home, "keycheck"))).toBe(false);
    expect(existsSync(join(home, "salt"))).toBe(false);
  });

  it("creates a passphrase-derived key lazily, then reopens it without create", async () => {
    process.env.TALLY_KEY_SOURCE = "passphrase";
    const ks = await openKeystore({ askPassphrase: async () => "correct horse battery" });
    expect(ks.source).toBe("passphrase");
    expect(masterKeyExists()).toBe(true);
    expect(existsSync(join(home, "salt"))).toBe(true);
    const blob = ks.seal("sk-or-v1-0123456789abcdef0123456789");
    expect(blob.toString("latin1")).not.toContain("sk-or-v1");

    const again = await openKeystore({ create: false, askPassphrase: async () => "correct horse battery" });
    expect(again.open(blob)).toBe("sk-or-v1-0123456789abcdef0123456789");
  });

  it("rejects a wrong passphrase with master-key-mismatch instead of garbage", async () => {
    process.env.TALLY_KEY_SOURCE = "passphrase";
    await openKeystore({ askPassphrase: async () => "correct horse battery" });
    await expect(openKeystore({ create: false, askPassphrase: async () => "wrong horse" })).rejects.toMatchObject({
      code: "master-key-mismatch",
    });
  });

  it("uses TALLY_MASTER_KEY from the env without touching the store", async () => {
    process.env.TALLY_MASTER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    expect(masterKeyExists()).toBe(true);
    const ks = await openKeystore({ create: false });
    expect(ks.source).toBe("env:TALLY_MASTER_KEY");
    expect(ks.open(ks.seal("secret"))).toBe("secret");
    expect(existsSync(join(home, "salt"))).toBe(false);
  });

  it("TALLY_KEY_SOURCE=passphrase without a prompt fails clearly", async () => {
    process.env.TALLY_KEY_SOURCE = "passphrase";
    await expect(openKeystore()).rejects.toMatchObject({ code: "no-key-source" });
  });

  it("a PassphraseKeySource with no salt yields null (nothing stored yet)", async () => {
    const src = new PassphraseKeySource(async () => "x");
    expect(await src.get()).toBeNull();
  });
});
