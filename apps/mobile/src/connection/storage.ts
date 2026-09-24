import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  removeCatalogValue,
  replaceCatalogValue,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
  GitHubRoutingPermissions,
  makeGitHubRoutingPermissions,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CatalogStore from "./catalog-store";
import { disconnectMobileSshEnvironment, mobileSshSecrets } from "../ssh/manager";
import { cleanupPreviousSsh } from "../ssh/cleanup";
import { markStagedMobileSshCommitted } from "../ssh/gateway";

const sshCleanupActions = {
  disconnect: disconnectMobileSshEnvironment,
  removeCredentials: mobileSshSecrets.removeCredentials,
  removeTrustedKey: mobileSshSecrets.removeTrustedKey,
};

function reportSshCleanupError(): void {
  // The catalog mutation has already committed. Reporting failure would cause
  // onboarding to discard the new key while leaving its catalog entry saved.
  console.warn("Could not finish cleaning up a previous SSH connection.");
}

function targetPersistenceError(
  operation:
    | "list-targets"
    | "list-disabled-targets"
    | "register-connection"
    | "remove-connection"
    | "set-connection-enabled",
  error: ConnectionTransientError,
) {
  return new ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    const githubRoutingPermissions = yield* makeGitHubRoutingPermissions({
      read: catalog.read.pipe(Effect.map((document) => document.githubRoutingPermissions ?? [])),
      write: (githubRoutingPermissions) =>
        catalog.update((document) => ({ ...document, githubRoutingPermissions })),
    });

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        Effect.gen(function* () {
          const previous = yield* catalog.read;
          yield* catalog.update((document) => registerConnectionInCatalog(document, registration));
          if (registration._tag === "SshConnectionRegistration") {
            yield* Effect.sync(() =>
              markStagedMobileSshCommitted(
                registration.profile.target,
                registration.target.connectionId,
              ),
            );
          }
          const next = yield* catalog.read;
          yield* Effect.tryPromise({
            try: () =>
              cleanupPreviousSsh(
                previous,
                next,
                registration.target.environmentId,
                sshCleanupActions,
              ),
            catch: () => new Error("SSH cleanup failed"),
          }).pipe(Effect.catch(() => Effect.sync(reportSshCleanupError)));
        }).pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error))),
      remove: (target) =>
        Effect.gen(function* () {
          const previous = yield* catalog.read;
          yield* catalog.update((document) => removeConnectionFromCatalog(document, target));
          const next = yield* catalog.read;
          yield* Effect.tryPromise({
            try: () => cleanupPreviousSsh(previous, next, target.environmentId, sshCleanupActions),
            catch: () => new Error("SSH cleanup failed"),
          }).pipe(Effect.catch(() => Effect.sync(reportSshCleanupError)));
        }).pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error))),
      setEnabled: (environmentId, enabled) =>
        catalog
          .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
          .pipe(
            Effect.mapError((error) => targetPersistenceError("set-connection-enabled", error)),
          ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((candidate) => candidate.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) => catalog.update((document) => putRemoteDpopTokenInCatalog(document, token)),
      remove: (environmentId) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(GitHubRoutingPermissions, githubRoutingPermissions),
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
    );
  }),
);
