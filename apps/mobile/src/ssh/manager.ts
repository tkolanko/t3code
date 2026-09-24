import type { SshHostKey } from "@osuki-dev/react-native-ssh";
import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  decodeRemoteLaunchOutput,
  decodeRemotePairingOutput,
} from "@t3tools/ssh/remoteBootstrap";
import * as Effect from "effect/Effect";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";

import { makeSshSecretStore, sameHostKey, type TrustedSshHostKey } from "./secrets";
import { throwIfSshAborted } from "./abort";
import {
  openMobileSshSession,
  type MobileSshCredentials,
  type MobileSshSession,
} from "./transport";

export type HostTrustDecision = (input: {
  readonly host: string;
  readonly port: number;
  readonly key: SshHostKey;
}) => Promise<boolean>;

interface SshEntry {
  readonly session: MobileSshSession;
  readonly credentialFingerprint: string;
  readonly forward: Awaited<ReturnType<MobileSshSession["forwardLoopback"]>>;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

const secrets = makeSshSecretStore();
const entries = new Map<string, SshEntry>();
const pending = new Map<string, Promise<SshEntry>>();
let trustDecision: HostTrustDecision | null = null;

export class SshHostKeyChangedError extends Error {
  constructor(
    readonly expectedFingerprint: string,
    readonly receivedFingerprint: string,
  ) {
    super(
      "The SSH host key changed. Remove the saved environment after checking the host, then connect again.",
    );
    this.name = "SshHostKeyChangedError";
  }
}

function remoteRunner() {
  const archiveVersion = Constants.expoConfig?.extra?.sshCliVersion;
  if (typeof archiveVersion !== "string" || archiveVersion.trim() === "") {
    throw new Error("No t3 release version was provided for the remote runtime.");
  }
  return { archiveVersion };
}

export function setMobileSshHostTrustDecision(decision: HostTrustDecision | null): void {
  trustDecision = decision;
}

function targetKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

async function stateKey(target: DesktopSshEnvironmentTarget): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    targetKey(target),
  );
  return hash.slice(0, 16);
}

function credentialFingerprint(credentials: MobileSshCredentials): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([credentials.privateKey, credentials.passphrase ?? ""]),
  );
}

async function verifyHostKey(
  credentials: MobileSshCredentials,
  key: SshHostKey,
  onChanged: (saved: TrustedSshHostKey) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfSshAborted(signal);
  const saved: TrustedSshHostKey | null = await secrets.loadTrustedKey(
    credentials.host,
    credentials.port,
  );
  throwIfSshAborted(signal);
  if (saved !== null) {
    if (sameHostKey(saved, key)) return true;
    onChanged(saved);
    return false;
  }
  const accepted = await trustDecision?.({
    host: credentials.host,
    port: credentials.port,
    key,
  });
  if (accepted !== true) return false;
  throwIfSshAborted(signal);
  await secrets.saveTrustedKey(credentials.host, credentials.port, key);
  return true;
}

async function healthy(entry: SshEntry): Promise<boolean> {
  if (!entry.session.connection.isConnected || !entry.forward.isOpen) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(entry.httpBaseUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function createEntry(
  target: DesktopSshEnvironmentTarget,
  credentials: MobileSshCredentials,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<SshEntry> {
  throwIfSshAborted(signal);
  let changedKey: SshHostKeyChangedError | null = null;
  const pinnedKey = await secrets.loadTrustedKey(credentials.host, credentials.port);
  throwIfSshAborted(signal);
  const session = await openMobileSshSession(
    credentials,
    (key) =>
      verifyHostKey(
        credentials,
        key,
        (saved) => {
          changedKey = new SshHostKeyChangedError(saved.fingerprint, key.fingerprint);
        },
        signal,
      ),
    pinnedKey?.algorithm,
    signal,
  ).catch((error: unknown) => {
    if (changedKey) throw changedKey;
    throw error;
  });
  try {
    const launch = await session.runScript(
      buildRemoteLaunchScript(remoteRunner()),
      [await stateKey(target)],
      signal,
    );
    throwIfSshAborted(signal);
    const parsed = await Effect.runPromise(decodeRemoteLaunchOutput(launch.stdout));
    if (
      !Number.isInteger(parsed.remotePort) ||
      parsed.remotePort < 1 ||
      parsed.remotePort > 65535
    ) {
      throw new Error("The SSH host returned an invalid T3 server port.");
    }
    const forward = await session.forwardLoopback(parsed.remotePort);
    throwIfSshAborted(signal);
    const httpBaseUrl = `http://127.0.0.1:${forward.localPort}/`;
    const entry: SshEntry = {
      session,
      credentialFingerprint: fingerprint,
      forward,
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      httpBaseUrl,
      wsBaseUrl: `ws://127.0.0.1:${forward.localPort}/`,
    };
    if (!(await healthy(entry)))
      throw new Error("The remote T3 server did not respond through SSH.");
    return entry;
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function ensureEntry(
  target: DesktopSshEnvironmentTarget,
  credentials: MobileSshCredentials,
  signal?: AbortSignal,
): Promise<SshEntry> {
  throwIfSshAborted(signal);
  const key = targetKey(target);
  const fingerprint = await credentialFingerprint(credentials);
  const inFlight = pending.get(key);
  if (inFlight) {
    const result = await inFlight.catch(() => undefined);
    throwIfSshAborted(signal);
    if (result?.credentialFingerprint === fingerprint) return result;
    if (pending.get(key) === inFlight) pending.delete(key);
    return ensureEntry(target, credentials, signal);
  }
  const operation = (async () => {
    const existing = entries.get(key);
    if (existing && existing.credentialFingerprint === fingerprint && (await healthy(existing))) {
      return existing;
    }
    if (existing) {
      entries.delete(key);
      await existing.session.close();
    }
    const created = await createEntry(target, credentials, fingerprint, signal);
    entries.set(key, created);
    return created;
  })();
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}

export async function ensureMobileSshEnvironment(
  target: DesktopSshEnvironmentTarget,
  credentials: MobileSshCredentials,
  issuePairingToken: boolean,
  signal?: AbortSignal,
): Promise<DesktopSshEnvironmentBootstrap> {
  const entry = await ensureEntry(target, credentials, signal);
  throwIfSshAborted(signal);
  let pairingToken: string | null = null;
  if (issuePairingToken) {
    const result = await entry.session.runScript(
      buildRemotePairingScript(await stateKey(target), remoteRunner()),
      [],
      signal,
    );
    throwIfSshAborted(signal);
    const parsed = await Effect.runPromise(decodeRemotePairingOutput(result.stdout));
    if (!parsed.credential.trim())
      throw new Error("The SSH host did not issue a pairing credential.");
    pairingToken = parsed.credential;
  }
  return {
    target,
    httpBaseUrl: entry.httpBaseUrl,
    wsBaseUrl: entry.wsBaseUrl,
    pairingToken,
    remotePort: entry.remotePort,
    ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
  };
}

export async function disconnectMobileSshEnvironment(
  target: DesktopSshEnvironmentTarget,
): Promise<void> {
  const key = targetKey(target);
  const inFlight = pending.get(key);
  if (inFlight) await inFlight.catch(() => undefined);
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  await entry.session.close();
}

export const mobileSshSecrets = secrets;
