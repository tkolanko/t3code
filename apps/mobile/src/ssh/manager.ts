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
// Outlives failed attempts so a reconnect after a network drop can go straight
// to the remote server instead of rerunning the launch script.
const lastRemote = new Map<
  string,
  Pick<SshEntry, "remotePort" | "remoteServerKind" | "credentialFingerprint">
>();
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

const HEALTH_TIMEOUT_MS = 2_000;
const STALE_CLOSE_TIMEOUT_MS = 1_000;

// Hits the environment descriptor so a reused port is proven to still be a T3
// server, not just any listener.
async function healthy(entry: SshEntry): Promise<boolean> {
  if (!entry.session.connection.isConnected || !entry.forward.isOpen) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${entry.httpBaseUrl}.well-known/t3/environment`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// A session that died while the app was suspended can block on disconnect, so
// never let closing it hold up the replacement.
function closeStale(session: MobileSshSession): Promise<void> {
  return Promise.race([
    session.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, STALE_CLOSE_TIMEOUT_MS)),
  ]);
}

async function forwardTo(
  base: Pick<SshEntry, "session" | "credentialFingerprint" | "remoteServerKind">,
  remotePort: number,
  signal?: AbortSignal,
): Promise<SshEntry | null> {
  const forward = await base.session.forwardLoopback(remotePort);
  throwIfSshAborted(signal);
  const entry: SshEntry = {
    ...base,
    forward,
    remotePort,
    httpBaseUrl: `http://127.0.0.1:${forward.localPort}/`,
    wsBaseUrl: `ws://127.0.0.1:${forward.localPort}/`,
  };
  if (await healthy(entry)) return entry;
  await forward.close().catch(() => undefined);
  return null;
}

async function launchAndForward(
  target: DesktopSshEnvironmentTarget,
  session: MobileSshSession,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<SshEntry> {
  const launch = await session.runScript(
    buildRemoteLaunchScript(remoteRunner()),
    [await stateKey(target)],
    { loginShell: true, ...(signal ? { signal } : {}) },
  );
  throwIfSshAborted(signal);
  const parsed = await Effect.runPromise(decodeRemoteLaunchOutput(launch.stdout));
  if (!Number.isInteger(parsed.remotePort) || parsed.remotePort < 1 || parsed.remotePort > 65535) {
    throw new Error("The SSH host returned an invalid T3 server port.");
  }
  const entry = await forwardTo(
    { session, credentialFingerprint: fingerprint, remoteServerKind: parsed.serverKind ?? null },
    parsed.remotePort,
    signal,
  );
  if (!entry) throw new Error("The remote T3 server did not respond through SSH.");
  return entry;
}

async function openSession(
  credentials: MobileSshCredentials,
  signal?: AbortSignal,
): Promise<MobileSshSession> {
  throwIfSshAborted(signal);
  let changedKey: SshHostKeyChangedError | null = null;
  const pinnedKey = await secrets.loadTrustedKey(credentials.host, credentials.port);
  throwIfSshAborted(signal);
  return openMobileSshSession(
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
}

// Recovers in the cheapest order: a new forward on the live session, then a
// new session to the last known remote port, and only then the launch script.
// The remote server outlives the SSH session, so a resume rarely needs launch.
async function recoverEntry(
  target: DesktopSshEnvironmentTarget,
  credentials: MobileSshCredentials,
  fingerprint: string,
  previous: SshEntry | undefined,
  signal?: AbortSignal,
): Promise<SshEntry> {
  const known = lastRemote.get(targetKey(target));
  const resume = (session: MobileSshSession) =>
    known?.credentialFingerprint === fingerprint
      ? forwardTo(
          { session, credentialFingerprint: fingerprint, remoteServerKind: known.remoteServerKind },
          known.remotePort,
          signal,
        )
      : Promise.resolve(null);

  if (previous) {
    if (previous.credentialFingerprint === fingerprint && previous.session.connection.isConnected) {
      await previous.forward.close().catch(() => undefined);
      const resumed = await resume(previous.session).catch(() => null);
      if (resumed) return resumed;
    }
    // A session that answers nothing may be half-dead after suspension, so
    // the launch script runs on a fresh one rather than hanging on it.
    void closeStale(previous.session);
  }

  const session = await openSession(credentials, signal);
  try {
    return (
      (await resume(session)) ?? (await launchAndForward(target, session, fingerprint, signal))
    );
  } catch (error) {
    await closeStale(session);
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
    entries.delete(key);
    const recovered = await recoverEntry(target, credentials, fingerprint, existing, signal);
    entries.set(key, recovered);
    lastRemote.set(key, recovered);
    return recovered;
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
      signal ? { signal } : {},
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
  lastRemote.delete(key);
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  await entry.session.close();
}

export const mobileSshSecrets = secrets;
