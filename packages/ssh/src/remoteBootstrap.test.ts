import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  decodeRemoteLaunchOutput,
  decodeRemotePairingOutput,
} from "./remoteBootstrap.ts";

describe("shared SSH remote bootstrap", () => {
  it.effect("reads startup and pairing responses after remote shell banners", () =>
    Effect.gen(function* () {
      const launch = yield* decodeRemoteLaunchOutput(
        'Welcome to the host\n{"remotePort":3773,"serverKind":"managed"}\n',
      );
      const pairing = yield* decodeRemotePairingOutput(
        'Last login today\n{"credential":"one-time-token"}\n',
      );
      expect(launch).toEqual({ remotePort: 3773, serverKind: "managed" });
      expect(pairing.credential).toBe("one-time-token");
    }),
  );

  it("uses the same remote state key in launch and pairing scripts", () => {
    const stateKey = "0123456789abcdef";
    const runner = { archiveVersion: "1.3.1" };
    const launch = buildRemoteLaunchScript(runner);
    const pairing = buildRemotePairingScript(stateKey, runner);

    expect(launch).toContain('STATE_KEY="$1"');
    expect(pairing).toContain(`ssh-launch/${stateKey}`);
    expect(pairing).not.toContain("@@T3_STATE_KEY@@");
  });
});
