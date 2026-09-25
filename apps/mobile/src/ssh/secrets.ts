import type { SshHostKey } from "@osuki-dev/react-native-ssh";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import type { MobileSshCredentials } from "./transport";

export interface SshSecretStorage {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<void>;
}

export interface TrustedSshHostKey {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly publicKey: string;
}

const credentialPrefix = "t3.ssh.credential.";
const trustPrefix = "t3.ssh.host.";
const bearerPrefix = "t3.ssh.bearer.";

export function sshHostIdentity(host: string, port: number): string {
  return `${host.trim().toLowerCase()}\u0000${port}`;
}

export function sameHostKey(left: TrustedSshHostKey, right: SshHostKey): boolean {
  return left.algorithm === right.algorithm && left.publicKey === right.publicKey;
}

function parseCredentials(raw: string | null): MobileSshCredentials | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.host !== "string" ||
      typeof entry.port !== "number" ||
      typeof entry.username !== "string" ||
      typeof entry.privateKey !== "string" ||
      (entry.passphrase !== undefined && typeof entry.passphrase !== "string")
    ) {
      return null;
    }
    return entry as unknown as MobileSshCredentials;
  } catch {
    return null;
  }
}

function parseTrustedKey(raw: string | null): TrustedSshHostKey | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.algorithm !== "string" ||
      typeof entry.fingerprint !== "string" ||
      typeof entry.publicKey !== "string"
    ) {
      return null;
    }
    return entry as unknown as TrustedSshHostKey;
  } catch {
    return null;
  }
}

export function makeSshSecretStore(
  storage: SshSecretStorage = SecureStore,
  digest: (value: string) => Promise<string> = (value) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
) {
  const keyFor = async (prefix: string, value: string) => `${prefix}${await digest(value)}`;
  const credentialKey = (connectionId: string) => keyFor(credentialPrefix, connectionId);
  const trustKey = (host: string, port: number) => keyFor(trustPrefix, sshHostIdentity(host, port));
  const bearerKey = (connectionId: string) => keyFor(bearerPrefix, connectionId);

  return {
    loadCredentials: async (connectionId: string) =>
      parseCredentials(await storage.getItemAsync(await credentialKey(connectionId))),
    saveCredentials: async (connectionId: string, credentials: MobileSshCredentials) =>
      storage.setItemAsync(await credentialKey(connectionId), JSON.stringify(credentials)),
    removeCredentials: async (connectionId: string) => {
      await storage.deleteItemAsync(await credentialKey(connectionId));
      await storage.deleteItemAsync(await bearerKey(connectionId));
    },
    // The bearer token from the last pairing, reused on reconnect so the host
    // does not start the t3 CLI to pair again every time the app resumes.
    loadBearerToken: async (connectionId: string) =>
      storage.getItemAsync(await bearerKey(connectionId)),
    saveBearerToken: async (connectionId: string, token: string) =>
      storage.setItemAsync(await bearerKey(connectionId), token),
    removeBearerToken: async (connectionId: string) =>
      storage.deleteItemAsync(await bearerKey(connectionId)),
    loadTrustedKey: async (host: string, port: number) =>
      parseTrustedKey(await storage.getItemAsync(await trustKey(host, port))),
    saveTrustedKey: async (host: string, port: number, key: SshHostKey) =>
      storage.setItemAsync(
        await trustKey(host, port),
        JSON.stringify({
          algorithm: key.algorithm,
          fingerprint: key.fingerprint,
          publicKey: key.publicKey,
        } satisfies TrustedSshHostKey),
      ),
    removeTrustedKey: async (host: string, port: number) =>
      storage.deleteItemAsync(await trustKey(host, port)),
  };
}
