import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionRegistration,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" } }));
vi.mock("expo-secure-store", () => ({}));

import { cleanupPreviousSsh } from "./cleanup";

function sshRegistration(id: string, host = "example.test") {
  const environmentId = EnvironmentId.make(id);
  const connectionId = `ssh:${id}`;
  const target = { alias: host, hostname: host, username: "alice", port: null };
  return new SshConnectionRegistration({
    target: new SshConnectionTarget({ environmentId, label: id, connectionId }),
    profile: new SshConnectionProfile({ connectionId, environmentId, label: id, target }),
  });
}

function actions() {
  const calls: string[] = [];
  return {
    calls,
    disconnect: async () => {
      calls.push("disconnect");
    },
    removeCredentials: async (id: string) => {
      calls.push(`credentials:${id}`);
    },
    removeTrustedKey: async (host: string, port: number) => {
      calls.push(`trust:${host}:${port}`);
    },
  };
}

describe("mobile SSH cleanup", () => {
  it("removes the key and host trust after the final saved connection is removed", async () => {
    const registration = sshRegistration("first");
    const before = registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, registration);
    const after = removeConnectionFromCatalog(before, registration.target);
    const cleanup = actions();

    await cleanupPreviousSsh(before, after, registration.target.environmentId, cleanup);
    expect(cleanup.calls).toEqual(["disconnect", "credentials:ssh:first", "trust:example.test:22"]);
  });

  it("keeps host trust while another saved SSH profile uses that host", async () => {
    const first = sshRegistration("first");
    const second = sshRegistration("second");
    const before = registerConnectionInCatalog(
      registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, first),
      second,
    );
    const after = removeConnectionFromCatalog(before, first.target);
    const cleanup = actions();

    await cleanupPreviousSsh(before, after, first.target.environmentId, cleanup);
    expect(cleanup.calls).toEqual(["disconnect", "credentials:ssh:first"]);
  });

  it("keeps the credential when an SSH registration replaces itself", async () => {
    const registration = sshRegistration("first");
    const before = registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, registration);
    const after = registerConnectionInCatalog(before, registration);
    const cleanup = actions();

    await cleanupPreviousSsh(before, after, registration.target.environmentId, cleanup);
    expect(cleanup.calls).toEqual([]);
  });

  it("disconnects the old target when an SSH environment moves to another host", async () => {
    const original = sshRegistration("first", "old.example.test");
    const replacement = sshRegistration("first", "new.example.test");
    const before = registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, original);
    const after = registerConnectionInCatalog(before, replacement);
    const cleanup = actions();

    await cleanupPreviousSsh(before, after, original.target.environmentId, cleanup);
    expect(cleanup.calls).toEqual(["disconnect", "trust:old.example.test:22"]);
  });

  it("clears SSH credentials when direct pairing replaces the same environment", async () => {
    const ssh = sshRegistration("first");
    const before = registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, ssh);
    const direct = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: ssh.target.environmentId,
        label: "direct",
        connectionId: "bearer:first",
      }),
      profile: new BearerConnectionProfile({
        connectionId: "bearer:first",
        environmentId: ssh.target.environmentId,
        label: "direct",
        httpBaseUrl: "https://host.example.test/",
        wsBaseUrl: "wss://host.example.test/",
      }),
      credential: new BearerConnectionCredential({ token: "bearer-token" }),
    });
    const after = registerConnectionInCatalog(before, direct);
    const cleanup = actions();

    await cleanupPreviousSsh(before, after, ssh.target.environmentId, cleanup);
    expect(cleanup.calls).toEqual(["disconnect", "credentials:ssh:first", "trust:example.test:22"]);
    expect(after.targets[0]?._tag).toBe("BearerConnectionTarget");
  });
});
