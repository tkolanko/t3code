import { ConnectionBlockedError, ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  clearStagedMobileSshCredentials,
  discardStagedMobileSshCredentials,
  isStagedMobileSshCommitted,
} from "../ssh/gateway";
import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    // Adding a route to a different machine with the same link is its own
    // operation: it must check its own expected machine.
    key: (input: { readonly pairingUrl: string; readonly expectedEnvironmentId?: EnvironmentId }) =>
      JSON.stringify([input.pairingUrl, input.expectedEnvironmentId ?? null]),
  },
  execute: (input: {
    readonly pairingUrl: string;
    /** Set when adding a route to this saved machine. */
    readonly expectedEnvironmentId?: EnvironmentId;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) =>
      `${input.target.hostname}:${input.target.port ?? 22}:${input.target.username ?? ""}`,
  },
  execute: (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly label?: string;
    readonly signal?: AbortSignal;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) =>
        input.signal?.aborted
          ? Effect.fail(
              new ConnectionBlockedError({
                reason: "authentication",
                detail: "SSH connection was cancelled.",
              }),
            )
          : onboarding.registerSsh(input),
      ),
      Effect.flatMap((environmentId) =>
        input.signal?.aborted
          ? Effect.fail(
              new ConnectionBlockedError({
                reason: "authentication",
                detail: "SSH connection was cancelled.",
              }),
            )
          : isStagedMobileSshCommitted(input.target)
            ? Effect.succeed(environmentId)
            : Effect.fail(
                new ConnectionBlockedError({
                  reason: "configuration",
                  detail:
                    "This environment is managed by another connection and cannot be replaced with SSH.",
                }),
              ),
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.sync(() => clearStagedMobileSshCredentials(input.target))
          : Effect.promise(() => discardStagedMobileSshCredentials(input.target)),
      ),
    ),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.updateBearer(input)),
    ),
});
