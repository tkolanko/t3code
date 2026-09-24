import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { SshEnvironmentGateway } from "@t3tools/client-runtime/platform";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { AuthStandardClientScopes, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import Constants from "expo-constants";

import { authClientMetadata } from "../lib/authClientMetadata";
import { throwIfSshAborted } from "./abort";
import {
  disconnectMobileSshEnvironment,
  ensureMobileSshEnvironment,
  mobileSshSecrets,
  SshHostKeyChangedError,
} from "./manager";
import type { MobileSshCredentials } from "./transport";

interface StagedSshCredentials {
  readonly credentials: MobileSshCredentials;
  readonly signal?: AbortSignal;
  savedConnectionId?: string;
  previousCredentials?: MobileSshCredentials | null;
  committed?: boolean;
}

const staged = new Map<string, StagedSshCredentials>();

function targetKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? 22}`;
}

export function stageMobileSshCredentials(
  target: DesktopSshEnvironmentTarget,
  credentials: MobileSshCredentials,
  signal?: AbortSignal,
): void {
  staged.set(targetKey(target), { credentials, signal });
}

export function clearStagedMobileSshCredentials(target: DesktopSshEnvironmentTarget): void {
  staged.delete(targetKey(target));
}

export function isStagedMobileSshCommitted(target: DesktopSshEnvironmentTarget): boolean {
  return staged.get(targetKey(target))?.committed === true;
}

export function markStagedMobileSshCommitted(
  target: DesktopSshEnvironmentTarget,
  connectionId: string,
): void {
  const pending = staged.get(targetKey(target));
  if (pending?.savedConnectionId === connectionId) pending.committed = true;
}

export async function discardStagedMobileSshCredentials(
  target: DesktopSshEnvironmentTarget,
): Promise<void> {
  const pending = staged.get(targetKey(target));
  staged.delete(targetKey(target));
  await disconnectMobileSshEnvironment(target).catch(() => undefined);
  if (pending?.savedConnectionId && !pending.committed) {
    if (pending.previousCredentials) {
      await mobileSshSecrets.saveCredentials(
        pending.savedConnectionId,
        pending.previousCredentials,
      );
    } else {
      await mobileSshSecrets.removeCredentials(pending.savedConnectionId);
    }
  }
}

function connectionError(cause: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "SSH connection was cancelled.",
    });
  }
  if (cause instanceof SshHostKeyChangedError) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail: `${cause.message} Expected ${cause.expectedFingerprint}; received ${cause.receivedFingerprint}.`,
    });
  }
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  if (code === "HOST_KEY_REJECTED") {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH host key was not trusted. Check its fingerprint and try again.",
    });
  }
  if (code === "AUTH_FAILED" || code === "KEY") {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "SSH key authentication failed. Check the key, passphrase, and username.",
    });
  }
  if (code === "CANCELLED") {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "SSH connection was cancelled.",
    });
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: "SSH connection was cancelled.",
    });
  }
  const message = cause instanceof Error ? cause.message : "";
  if (message === "Saved SSH key is missing.") {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail:
        "The saved SSH key is missing from this device. Remove the environment and add it again.",
    });
  }
  if (
    message.includes("not an exact t3 version") ||
    message.includes("No t3 release version") ||
    message.includes("Checksum mismatch") ||
    message.includes("404")
  ) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail:
        "The remote T3 version could not be installed. Update the mobile app or check that its matching T3 release is available.",
    });
  }
  if (
    message.includes("Remote host is missing node") ||
    message.includes("does not run on this host")
  ) {
    return new ConnectionBlockedError({
      reason: "configuration",
      detail:
        "The SSH host cannot run this T3 server version. Check its platform and runtime requirements.",
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail:
      "Could not connect to the T3 environment over SSH. Check the host, port, and server availability.",
  });
}

async function remoteAuthorization(
  httpBaseUrl: string,
  pairingToken: string,
  signal?: AbortSignal,
) {
  throwIfSshAborted(signal);
  const http = remoteHttpClientLayer((input, init) =>
    globalThis.fetch(input, signal ? { ...init, signal } : init),
  );
  const descriptor = await Effect.runPromise(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(Effect.provide(http)),
  );
  const access = await Effect.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl,
      credential: pairingToken,
      scopes: AuthStandardClientScopes,
      clientMetadata: authClientMetadata(Constants.expoConfig?.version),
    }).pipe(Effect.provide(http)),
  );
  throwIfSshAborted(signal);
  return { descriptor, access };
}

export const mobileSshGateway = SshEnvironmentGateway.of({
  provision: (target) =>
    Effect.tryPromise({
      try: async () => {
        const pending = staged.get(targetKey(target));
        if (!pending) throw new Error("SSH key was not staged for this connection.");
        const bootstrap = await ensureMobileSshEnvironment(
          target,
          pending.credentials,
          true,
          pending.signal,
        );
        if (!bootstrap.pairingToken)
          throw new Error("The SSH host did not issue a pairing credential.");
        const { descriptor, access } = await remoteAuthorization(
          bootstrap.httpBaseUrl,
          bootstrap.pairingToken,
          pending.signal,
        );
        const connectionId = `ssh:${descriptor.environmentId}`;
        pending.previousCredentials = await mobileSshSecrets.loadCredentials(connectionId);
        throwIfSshAborted(pending.signal);
        await mobileSshSecrets.saveCredentials(connectionId, pending.credentials);
        pending.savedConnectionId = connectionId;
        return {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          bootstrap,
          bearerToken: access.access_token,
        };
      },
      catch: (cause) => connectionError(cause, staged.get(targetKey(target))?.signal),
    }),
  prepare: (input) =>
    Effect.tryPromise({
      try: async () => {
        const credentials = await mobileSshSecrets.loadCredentials(input.connectionId);
        if (!credentials) throw new Error("Saved SSH key is missing.");
        const bootstrap = await ensureMobileSshEnvironment(input.target, credentials, true);
        if (!bootstrap.pairingToken)
          throw new Error("The SSH host did not issue a pairing credential.");
        const { access } = await remoteAuthorization(bootstrap.httpBaseUrl, bootstrap.pairingToken);
        return { bootstrap, bearerToken: access.access_token };
      },
      catch: connectionError,
    }),
  disconnect: (target) =>
    Effect.tryPromise({
      try: () => disconnectMobileSshEnvironment(target),
      catch: connectionError,
    }),
});
