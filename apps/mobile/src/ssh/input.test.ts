import { describe, expect, it } from "@effect/vitest";

import { parseMobileSshInput } from "./input";

const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

describe("mobile SSH connection input", () => {
  it("accepts a pasted key and optional port without putting secrets in the target", () => {
    const parsed = parseMobileSshInput({
      host: " server.example.test ",
      username: "alice",
      privateKey: key,
      passphrase: "secret phrase",
      port: "2222",
    });
    expect(parsed.target).toEqual({
      alias: "server.example.test",
      hostname: "server.example.test",
      username: "alice",
      port: 2222,
    });
    expect(JSON.stringify(parsed.target)).not.toContain("secret phrase");
    expect(parsed.credentials.passphrase).toBe("secret phrase");
  });

  it("rejects URLs, invalid ports, and non-key text before connection", () => {
    expect(() =>
      parseMobileSshInput({ host: "https://host", username: "alice", privateKey: key }),
    ).toThrow("SSH host");
    expect(() =>
      parseMobileSshInput({ host: "host", username: "alice", privateKey: key, port: "65536" }),
    ).toThrow("SSH port");
    expect(() =>
      parseMobileSshInput({ host: "host", username: "alice", privateKey: "not a key" }),
    ).toThrow("private key");
  });
});
