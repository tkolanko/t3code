import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { makeSshSecretStore, sameHostKey } from "./secrets";

function memoryStore() {
  const items = new Map<string, string>();
  const storage = {
    getItemAsync: async (key: string) => items.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      items.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      items.delete(key);
    },
  };
  return { items, storage };
}

describe("mobile SSH secrets", () => {
  it("stores key material outside the connection catalog and removes it by connection ID", async () => {
    const memory = memoryStore();
    const secrets = makeSshSecretStore(memory.storage, async (value) =>
      Buffer.from(value).toString("hex"),
    );
    const credentials = {
      host: "example.test",
      port: 22,
      username: "alice",
      privateKey: "private-key-secret",
      passphrase: "passphrase-secret",
    };

    await secrets.saveCredentials("ssh:environment-1", credentials);
    expect(await secrets.loadCredentials("ssh:environment-1")).toEqual(credentials);
    expect(await secrets.loadCredentials("ssh:environment-2")).toBeNull();
    expect([...memory.items.keys()]).toHaveLength(1);
    expect([...memory.items.keys()][0]).not.toContain("environment-1");

    await secrets.saveBearerToken("ssh:environment-1", "bearer-secret");
    expect(await secrets.loadBearerToken("ssh:environment-1")).toBe("bearer-secret");

    await secrets.removeCredentials("ssh:environment-1");
    expect(await secrets.loadCredentials("ssh:environment-1")).toBeNull();
    expect(await secrets.loadBearerToken("ssh:environment-1")).toBeNull();
    expect(memory.items.size).toBe(0);
  });

  it("pins the full host key for a host and port and rejects a replacement", async () => {
    const memory = memoryStore();
    const secrets = makeSshSecretStore(memory.storage, async (value) =>
      Buffer.from(value).toString("hex"),
    );
    const key = {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:first",
      publicKey: "first-key",
    };
    await secrets.saveTrustedKey("EXAMPLE.test", 22, key);
    const trusted = await secrets.loadTrustedKey("example.test", 22);
    expect(trusted).toEqual(key);
    expect(trusted && sameHostKey(trusted, key)).toBe(true);
    expect(
      trusted && sameHostKey(trusted, { ...key, fingerprint: "SHA256:other", publicKey: "other" }),
    ).toBe(false);
    expect(await secrets.loadTrustedKey("example.test", 2222)).toBeNull();

    await secrets.removeTrustedKey("example.test", 22);
    expect(await secrets.loadTrustedKey("example.test", 22)).toBeNull();
  });
});
