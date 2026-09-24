import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  controller: null as AbortController | null,
  shellCloses: 0,
  disconnects: 0,
}));

vi.mock("@osuki-dev/react-native-ssh", () => ({
  connect: async () => ({
    isConnected: true,
    openShell: async (_options: unknown, handlers: { onClosed: (exitCode?: number) => void }) => ({
      write: () => harness.controller?.abort(),
      sendEof: () => undefined,
      close: async () => {
        harness.shellCloses += 1;
        handlers.onClosed(undefined);
      },
    }),
    forwardLocal: async () => ({ localPort: 4000, isOpen: true, close: async () => undefined }),
    disconnect: async () => {
      harness.disconnects += 1;
    },
  }),
}));

import { openMobileSshSession } from "./transport";

describe("mobile SSH transport", () => {
  it("closes an active remote shell when a command is cancelled", async () => {
    const controller = new AbortController();
    harness.controller = controller;
    harness.shellCloses = 0;
    harness.disconnects = 0;
    const session = await openMobileSshSession(
      { host: "host", port: 22, username: "alice", privateKey: "key" },
      async () => true,
    );

    await expect(session.runScript("echo ready", [], controller.signal)).rejects.toThrow(
      "SSH command was cancelled.",
    );
    expect(harness.shellCloses).toBeGreaterThan(0);
    await session.close();
    expect(harness.disconnects).toBe(1);
  });
});
