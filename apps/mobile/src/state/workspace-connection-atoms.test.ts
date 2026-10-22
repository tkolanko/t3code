import { describe, expect, it } from "@effect/vitest";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type EnvironmentPresentation,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";
import { projectWorkspaceEnvironment, projectWorkspaceState } from "./workspaceModel";

const ID = EnvironmentId.make("environment-1");
function presentation(): EnvironmentPresentation {
  return {
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId: ID,
        label: "Mac",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      }),
      enabled: true,
      profile: Option.none(),
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  };
}
function harness() {
  const source = Atom.make<EnvironmentPresentation | null>(presentation());
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([[ID, presentation().entry]]),
  });
  const network = Atom.make<NetworkStatus>("online");
  const atoms = createWorkspaceConnectionAtoms({
    catalogValueAtom: catalog,
    networkStatusValueAtom: network,
    presentationAtom: () => source,
  });
  const registry = AtomRegistry.make();
  return { source, catalog, network, registry, ...atoms };
}

describe("workspace connection subscriptions", () => {
  it("updates SSH controls when the connection target changes without changing its label or status", () => {
    const h = harness();
    const initial = h.registry.get(h.environmentsAtom);
    const stop = h.registry.subscribe(h.environmentsAtom, () => {});
    try {
      expect(initial[0]?.isSsh).toBe(false);
      const source = presentation();
      h.registry.set(h.source, {
        ...source,
        entry: {
          ...source.entry,
          target: new SshConnectionTarget({
            environmentId: ID,
            label: source.entry.target.label,
            connectionId: `ssh:${ID}`,
          }),
        },
      });
      const ssh = h.registry.get(h.environmentsAtom);
      expect(ssh).not.toBe(initial);
      expect(ssh[0]).toMatchObject({ isSsh: true, connectionState: "connected" });
      h.registry.set(h.source, presentation());
      expect(h.registry.get(h.environmentsAtom)[0]?.isSsh).toBe(false);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("keeps connection consumers stable across shell and provider updates", () => {
    const h = harness();
    const shell = Atom.make<EnvironmentShellSummary>({
      hasSnapshot: true,
      hasSynchronizingShell: false,
      hasCachedShell: false,
      hasLiveShell: true,
      firstError: null,
    });
    const broadState = Atom.make((get) =>
      projectWorkspaceState({
        isReady: get(h.catalog).isReady,
        networkStatus: get(h.network),
        environments: [projectWorkspaceEnvironment(ID, get(h.source)!)],
        shellSummary: get(shell),
        hasSyncingConnectedEnvironment: false,
      }),
    );
    const initial = h.registry.get(h.stateAtom);
    const initialEnvironments = h.registry.get(h.environmentsAtom);
    let broadChanges = 0;
    let connectionChanges = 0;
    const stopBroad = h.registry.subscribe(broadState, () => broadChanges++);
    const stopNarrow = h.registry.subscribe(h.stateAtom, () => connectionChanges++);
    try {
      for (let index = 0; index < 20; index++) {
        h.registry.set(shell, {
          ...h.registry.get(shell),
          hasSynchronizingShell: index % 2 === 0,
        });
        h.registry.get(broadState);
        h.registry.get(h.stateAtom);
      }
      expect(broadChanges).toBe(20);
      expect(connectionChanges).toBe(0);
      for (let index = 0; index < 4; index++) {
        const config = { cwd: `/workspace-${index}` } as ServerConfig;
        h.registry.set(h.source, { ...presentation(), serverConfig: config });
        expect(h.registry.get(h.source)?.serverConfig).toBe(config);
        expect(h.registry.get(h.stateAtom)).toBe(initial);
        expect(h.registry.get(h.environmentsAtom)).toBe(initialEnvironments);
      }
      expect(connectionChanges).toBe(0);
    } finally {
      stopBroad();
      stopNarrow();
      h.registry.dispose();
    }
  });
});
