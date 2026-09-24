import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

import { sshHostIdentity } from "./secrets";

export interface SshCleanupActions {
  readonly disconnect: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  readonly removeCredentials: (connectionId: string) => Promise<void>;
  readonly removeTrustedKey: (host: string, port: number) => Promise<void>;
}

export async function cleanupPreviousSsh(
  previous: ConnectionCatalogDocument,
  next: ConnectionCatalogDocument,
  environmentId: string,
  actions: SshCleanupActions,
): Promise<void> {
  const oldTarget = previous.targets.find((candidate) => candidate.environmentId === environmentId);
  if (oldTarget?._tag !== "SshConnectionTarget") return;
  const oldProfile = previous.profiles.find(
    (candidate) => candidate.connectionId === oldTarget.connectionId,
  );
  if (oldProfile?._tag !== "SshConnectionProfile") return;

  const replacement = next.profiles.find(
    (candidate) =>
      candidate._tag === "SshConnectionProfile" &&
      candidate.connectionId === oldTarget.connectionId,
  );
  const sameTarget =
    replacement?._tag === "SshConnectionProfile" &&
    replacement.target.alias === oldProfile.target.alias &&
    replacement.target.hostname === oldProfile.target.hostname &&
    replacement.target.username === oldProfile.target.username &&
    replacement.target.port === oldProfile.target.port;
  const cleanup: Array<Promise<void>> = sameTarget ? [] : [actions.disconnect(oldProfile.target)];
  const stillSaved = next.profiles.some(
    (candidate) =>
      candidate._tag === "SshConnectionProfile" &&
      candidate.connectionId === oldTarget.connectionId,
  );
  if (!stillSaved) cleanup.push(actions.removeCredentials(oldTarget.connectionId));

  const oldHost = sshHostIdentity(oldProfile.target.hostname, oldProfile.target.port ?? 22);
  const hostStillUsed = next.profiles.some(
    (candidate) =>
      candidate._tag === "SshConnectionProfile" &&
      sshHostIdentity(candidate.target.hostname, candidate.target.port ?? 22) === oldHost,
  );
  if (!hostStillUsed) {
    cleanup.push(
      actions.removeTrustedKey(oldProfile.target.hostname, oldProfile.target.port ?? 22),
    );
  }
  const results = await Promise.allSettled(cleanup);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("SSH cleanup failed");
  }
}
