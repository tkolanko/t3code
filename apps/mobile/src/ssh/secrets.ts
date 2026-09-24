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

  return {
    loadCredentials: async (connectionId: string) =>
      parseCredentials(await storage.getItemAsync(await credentialKey(connectionId))),
    saveCredentials: async (connectionId: string, credentials: MobileSshCredentials) =>
      storage.setItemAsync(await credentialKey(connectionId), JSON.stringify(credentials)),
    removeCredentials: async (connectionId: string) =>
      storage.deleteItemAsync(await credentialKey(connectionId)),
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
