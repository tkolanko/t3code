import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  opens: 0,
  closes: 0,
  trustedKey: null as null | { algorithm: string; fingerprint: string; publicKey: string },
  presentedKey: null as null | { algorithm: string; fingerprint: string; publicKey: string },
  preferredHostKeyAlgorithm: null as string | null,
  launchScripts: [] as string[],
  openedPrivateKeys: [] as string[],
  forwards: [] as Array<{ isOpen: boolean; localPort: number; close: () => Promise<void> }>,
  sessions: [] as Array<{ connection: { isConnected: boolean } }>,
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { sshCliVersion: "0.0.42" } } },
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: unknown, value: string) =>
    value.startsWith("[") ? value : "0123456789abcdefabcdef",
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./secrets", () => ({
  makeSshSecretStore: () => ({ loadTrustedKey: async () => harness.trustedKey }),
  sameHostKey: (left: { publicKey: string }, right: { publicKey: string }) =>
    left.publicKey === right.publicKey,
}));
vi.mock("./transport", () => ({
  openMobileSshSession: async (
    connectionCredentials: { privateKey: string },
    verifyHostKey: (key: {
      algorithm: string;
      fingerprint: string;
      publicKey: string;
    }) => Promise<boolean>,
    preferredHostKeyAlgorithm: string | undefined,
  ) => {
    harness.opens += 1;
    harness.openedPrivateKeys.push(connectionCredentials.privateKey);
    harness.preferredHostKeyAlgorithm = preferredHostKeyAlgorithm ?? null;
    if (harness.presentedKey && !(await verifyHostKey(harness.presentedKey))) {
      throw new Error("Host key rejected");
    }
    const session = {
      connection: { isConnected: true },
      forwards: [] as Array<{ isOpen: boolean; close: () => Promise<void> }>,
      runScript: async (script: string) => {
        if (!script.includes("auth pairing create")) harness.launchScripts.push(script);
        return {
          stdout: script.includes("auth pairing create")
            ? '{"credential":"pairing-token"}'
            : '{"remotePort":3773,"serverKind":"managed"}',
          stderr: "",
        };
      },
      forwardLoopback: async () => {
        const forward = {
          isOpen: true,
          localPort: 4001 + harness.forwards.length,
          close: async () => {
            forward.isOpen = false;
          },
        };
        harness.forwards.push(forward);
        session.forwards.push(forward);
        return forward;
      },
      close: async () => {
        harness.closes += 1;
        session.connection.isConnected = false;
        await Promise.all(session.forwards.map((forward) => forward.close()));
      },
    };
    harness.sessions.push(session);
    return session;
  },
}));

import {
  disconnectMobileSshEnvironment,
  ensureMobileSshEnvironment,
  SshHostKeyChangedError,
} from "./manager";

const target = { alias: "test", hostname: "test", username: "alice", port: null };
const credentials = {
  host: "test",
  port: 22,
  username: "alice",
  privateKey: "private-key",
};

afterEach(async () => {
  await disconnectMobileSshEnvironment(target);
  harness.opens = 0;
  harness.closes = 0;
  harness.trustedKey = null;
  harness.presentedKey = null;
  harness.preferredHostKeyAlgorithm = null;
  harness.launchScripts = [];
  harness.openedPrivateKeys = [];
  harness.forwards = [];
  harness.sessions = [];
  vi.unstubAllGlobals();
});

describe("mobile SSH tunnel manager", () => {
  it("reuses a healthy tunnel and issues pairing credentials per prepare", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    const first = await ensureMobileSshEnvironment(target, credentials, true);
    const second = await ensureMobileSshEnvironment(target, credentials, true);

    expect(first.httpBaseUrl).toBe("http://127.0.0.1:4001/");
    expect(second.httpBaseUrl).toBe(first.httpBaseUrl);
    expect(second.wsBaseUrl).toBe("ws://127.0.0.1:4001/");
    expect(second.pairingToken).toBe("pairing-token");
    expect(harness.opens).toBe(1);
    expect(harness.launchScripts[0]).toContain("T3_ARCHIVE_VERSION='0.0.42'");
  });

  it("reopens only the forward when the SSH session survived", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    await ensureMobileSshEnvironment(target, credentials, false);
    harness.forwards[0]!.isOpen = false;
    const renewed = await ensureMobileSshEnvironment(target, credentials, false);

    expect(renewed.httpBaseUrl).toBe("http://127.0.0.1:4002/");
    expect(harness.opens).toBe(1);
    expect(harness.closes).toBe(0);
    expect(harness.launchScripts).toHaveLength(1);

    await disconnectMobileSshEnvironment(target);
    expect(harness.closes).toBe(1);
    expect(harness.forwards[1]!.isOpen).toBe(false);
  });

  it("reconnects a dropped session straight to the known remote port", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    await ensureMobileSshEnvironment(target, credentials, false);
    harness.sessions[0]!.connection.isConnected = false;
    const renewed = await ensureMobileSshEnvironment(target, credentials, false);

    expect(renewed.remotePort).toBe(3773);
    expect(harness.opens).toBe(2);
    expect(harness.launchScripts).toHaveLength(1);
  });

  it("relaunches on a fresh session when the known port stops answering", async () => {
    let answeringAfterLaunches = 1;
    vi.stubGlobal("fetch", async () => ({
      ok: harness.launchScripts.length >= answeringAfterLaunches,
    }));
    await ensureMobileSshEnvironment(target, credentials, false);
    answeringAfterLaunches = 2;
    await ensureMobileSshEnvironment(target, credentials, false);

    expect(harness.launchScripts).toHaveLength(2);
    expect(harness.opens).toBe(2);
    expect(harness.closes).toBe(1);
  });

  it("authenticates a changed private key instead of reusing the old tunnel", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    await ensureMobileSshEnvironment(target, credentials, false);
    await ensureMobileSshEnvironment(
      target,
      { ...credentials, privateKey: "replacement-private-key" },
      false,
    );

    expect(harness.openedPrivateKeys).toEqual(["private-key", "replacement-private-key"]);
    expect(harness.closes).toBe(1);
  });

  it("keeps simultaneous SSH environments on separate local ports", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true }));
    const other = { alias: "other", hostname: "other", username: "bob", port: null };
    const [first, second] = await Promise.all([
      ensureMobileSshEnvironment(target, credentials, false),
      ensureMobileSshEnvironment(other, { ...credentials, host: "other", username: "bob" }, false),
    ]);

    expect(first.httpBaseUrl).not.toBe(second.httpBaseUrl);
    expect(harness.opens).toBe(2);
    await disconnectMobileSshEnvironment(other);
    expect(harness.forwards.filter((forward) => forward.isOpen)).toHaveLength(1);
    expect((await ensureMobileSshEnvironment(target, credentials, false)).httpBaseUrl).toBe(
      first.httpBaseUrl,
    );
  });

  it("rejects a changed host key and prefers the pinned algorithm", async () => {
    harness.trustedKey = {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:old",
      publicKey: "old-key",
    };
    harness.presentedKey = {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:new",
      publicKey: "new-key",
    };

    await expect(ensureMobileSshEnvironment(target, credentials, false)).rejects.toBeInstanceOf(
      SshHostKeyChangedError,
    );
    expect(harness.preferredHostKeyAlgorithm).toBe("ssh-ed25519");
    expect(harness.forwards).toHaveLength(0);
  });

  it("does not start SSH after onboarding is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureMobileSshEnvironment(target, credentials, true, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.opens).toBe(0);
  });
});
