import { beforeEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  bearers: new Map<string, string>(),
  acceptsBearer: true,
  ensures: [] as Array<{ target: unknown; issuePairingToken: boolean }>,
  disconnected: [] as unknown[],
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.3.1" } } }));
vi.mock("../lib/authClientMetadata", () => ({ authClientMetadata: () => ({ label: "Test" }) }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  fetchRemoteEnvironmentDescriptor: () =>
    Effect.succeed({ environmentId: "environment-1", label: "Remote T3" }),
}));
vi.mock("@t3tools/client-runtime/authorization", () => ({
  bootstrapRemoteBearerSession: () => Effect.succeed({ access_token: "bearer-token" }),
  fetchRemoteSessionState: () => Effect.succeed({ authenticated: harness.acceptsBearer }),
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({ remoteHttpClientLayer: () => Layer.empty }));
vi.mock("./manager", () => ({
  SshHostKeyChangedError: class extends Error {},
  ensureMobileSshEnvironment: async (
    target: unknown,
    _credentials: unknown,
    issuePairingToken: boolean,
  ) => {
    harness.ensures.push({ target, issuePairingToken });
    return {
      target,
      httpBaseUrl: "http://127.0.0.1:4000/",
      wsBaseUrl: "ws://127.0.0.1:4000/",
      remotePort: 3773,
      pairingToken: "pairing-token",
    };
  },
  disconnectMobileSshEnvironment: async (target: unknown) => {
    harness.disconnected.push(target);
  },
  mobileSshSecrets: {
    saveCredentials: async (id: string, credentials: unknown) => {
      harness.saved.set(id, credentials);
    },
    loadCredentials: async (id: string) => harness.saved.get(id) ?? null,
    removeCredentials: async (id: string) => {
      harness.saved.delete(id);
      harness.bearers.delete(id);
    },
    loadBearerToken: async (id: string) => harness.bearers.get(id) ?? null,
    saveBearerToken: async (id: string, token: string) => {
      harness.bearers.set(id, token);
    },
  },
}));

import {
  clearStagedMobileSshCredentials,
  discardStagedMobileSshCredentials,
  markStagedMobileSshCommitted,
  mobileSshGateway,
  stageMobileSshCredentials,
} from "./gateway";

const target = { alias: "test", hostname: "test", username: "alice", port: null };
const credentials = {
  host: "test",
  port: 22,
  username: "alice",
  privateKey: "private-key",
};

describe("mobile SSH gateway", () => {
  beforeEach(() => {
    harness.saved.clear();
    harness.bearers.clear();
    harness.acceptsBearer = true;
    harness.ensures.length = 0;
    harness.disconnected.length = 0;
  });

  it.effect(
    "associates staged credentials with the returned environment ID for later prepares",
    () =>
      Effect.gen(function* () {
        stageMobileSshCredentials(target, credentials);
        const provisioned = yield* mobileSshGateway.provision(target);
        clearStagedMobileSshCredentials(target);

        expect(provisioned.environmentId).toBe("environment-1");
        expect(provisioned.bearerToken).toBe("bearer-token");
        expect(harness.saved.get("ssh:environment-1")).toEqual(credentials);

        const prepared = yield* mobileSshGateway.prepare({
          connectionId: "ssh:environment-1",
          expectedEnvironmentId: provisioned.environmentId,
          target,
        });
        expect(prepared.bootstrap.httpBaseUrl).toBe("http://127.0.0.1:4000/");
        expect(prepared.bearerToken).toBe("bearer-token");
        expect(harness.ensures.map((ensure) => ensure.issuePairingToken)).toEqual([true, false]);
      }),
  );

  it.effect("pairs again only when the saved bearer token is rejected", () =>
    Effect.gen(function* () {
      harness.saved.set("ssh:environment-1", credentials);
      harness.bearers.set("ssh:environment-1", "revoked-token");
      harness.acceptsBearer = false;

      const prepared = yield* mobileSshGateway.prepare({
        connectionId: "ssh:environment-1",
        expectedEnvironmentId: EnvironmentId.make("environment-1"),
        target,
      });

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(harness.bearers.get("ssh:environment-1")).toBe("bearer-token");
      expect(harness.ensures.map((ensure) => ensure.issuePairingToken)).toEqual([false, true]);
    }),
  );

  it.effect("removes staged credentials and closes the tunnel after failed onboarding", () =>
    Effect.gen(function* () {
      stageMobileSshCredentials(target, credentials);
      yield* mobileSshGateway.provision(target);
      yield* Effect.promise(() => discardStagedMobileSshCredentials(target));

      expect(harness.saved.has("ssh:environment-1")).toBe(false);
      expect(harness.disconnected).toContainEqual(target);
    }),
  );

  it.effect("restores the previous key if replacing an SSH connection fails", () =>
    Effect.gen(function* () {
      const original = { ...credentials, privateKey: "previous-key" };
      harness.saved.set("ssh:environment-1", original);
      stageMobileSshCredentials(target, credentials);
      yield* mobileSshGateway.provision(target);
      yield* Effect.promise(() => discardStagedMobileSshCredentials(target));

      expect(harness.saved.get("ssh:environment-1")).toEqual(original);
    }),
  );

  it.effect("keeps the key when the catalog committed before onboarding failed", () =>
    Effect.gen(function* () {
      stageMobileSshCredentials(target, credentials);
      yield* mobileSshGateway.provision(target);
      markStagedMobileSshCommitted(target, "ssh:environment-1");
      yield* Effect.promise(() => discardStagedMobileSshCredentials(target));

      expect(harness.saved.get("ssh:environment-1")).toEqual(credentials);
    }),
  );

  it.effect("does not preserve a key when another target commits the environment", () =>
    Effect.gen(function* () {
      stageMobileSshCredentials(target, credentials);
      yield* mobileSshGateway.provision(target);
      markStagedMobileSshCommitted({ ...target, hostname: "other" }, "ssh:environment-1");
      yield* Effect.promise(() => discardStagedMobileSshCredentials(target));

      expect(harness.saved.has("ssh:environment-1")).toBe(false);
    }),
  );

  it.effect("clears a cancelled attempt without saving its key", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      stageMobileSshCredentials(target, credentials, controller.signal);
      controller.abort();

      const error = yield* Effect.flip(mobileSshGateway.provision(target));
      expect(error.detail).toBe("SSH connection was cancelled.");
      yield* Effect.promise(() => discardStagedMobileSshCredentials(target));
      expect(harness.saved.size).toBe(0);
    }),
  );
});
