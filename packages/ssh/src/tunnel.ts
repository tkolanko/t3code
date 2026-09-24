import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@t3tools/shared/httpReadiness";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSshChildEnvironment,
  type SshAuthOptions,
  SshPasswordPrompt,
  isSshAuthFailure,
} from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import * as RemoteBootstrap from "./remoteBootstrap.ts";
import {
  buildRemoteLaunchScript,
  decodeRemoteLaunchOutput,
  decodeRemotePairingOutput,
  type RemoteT3RunnerOptions,
} from "./remoteBootstrap.ts";

import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;

export { describeReadinessCause };
export type { RemoteT3RunnerOptions } from "./remoteBootstrap.ts";

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function sshRunnerLogFields(runner: RemoteT3RunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

export {
  buildRemoteLaunchScript,
  buildRemoteNodeEnvScript,
  buildRemoteT3RunnerScript,
  REMOTE_PICK_PORT_SCRIPT,
  SshInvalidArchiveVersionError,
  SshMissingRunnerError,
} from "./remoteBootstrap.ts";

export function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  runner?: RemoteT3RunnerOptions,
): string {
  return RemoteBootstrap.buildRemotePairingScript(remoteStateKey(target), runner);
}

export function buildRemoteStopScript(target: DesktopSshEnvironmentTarget): string {
  return RemoteBootstrap.buildRemoteStopScript(remoteStateKey(target));
}

function buildRemoteLogTailScript(target: DesktopSshEnvironmentTarget): string {
  return RemoteBootstrap.buildRemoteLogTailScript(remoteStateKey(target));
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<
    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey: remoteStateKey(target),
    });
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s", "--", remoteStateKey(target)],
      stdin: buildRemoteLaunchScript(runner),
      timeoutMs: runner?.nodeScriptPath?.trim()
        ? REMOTE_LAUNCH_TIMEOUT_MS
        : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      stateKey: remoteStateKey(target),
    });
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    // Pairing may be the first command on a cold remote, so it can install
    // the archive on the way.
    ...(runner?.nodeScriptPath?.trim() ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  return {
    credential: parsed.credential,
  };
});

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(target),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(target),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) => {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const targetLocks = new Map<string, Semaphore.Semaphore>();
  const authSecrets = new Map<string, string>();

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    let lock = targetLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      targetLocks.set(key, lock);
    }
    return yield* lock.withPermits(1)(effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteT3RunnerOptions;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const remoteLaunch = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner),
    });
    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
        }).pipe(Effect.provideService(Scope.Scope, entryScope)),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;
        if (stopRemote) {
          tunnels.delete(tunnelEntry.key);
        }
        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);
        if (!stopRemote) {
          return;
        }
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
        yield* stopRemoteServer(
          tunnelEntry.target,
          authSecret === null
            ? {
                batchMode: "yes",
                interactiveAuth: false,
              }
            : {
                authSecret,
                batchMode: "no",
                interactiveAuth: true,
              },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
          Effect.provideService(FileSystem.FileSystem, fileSystemService),
          Effect.provideService(Path.Path, pathService),
        );
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });
        return entry;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      });
      yield* closeTunnelEntry(entry);
    }

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    return yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner);

        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner),
            })
          : null;
        const pairingToken = pairingResult?.credential ?? null;

        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          remoteServerKind: entry.remoteServerKind,
          issuedPairingToken: pairingToken !== null,
        });
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          // Explicit disconnect owns the remote stop so its failure reaches the caller.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }
        yield* runWithSshAuth({
          key,
          target: resolvedTarget,
          operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
        });
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@t3tools/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
