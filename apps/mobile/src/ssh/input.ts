import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

import type { MobileSshCredentials } from "./transport";

export interface MobileSshFormInput {
  readonly host: string;
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string;
  readonly port?: string;
  readonly signal?: AbortSignal;
}

export function parseMobileSshInput(input: MobileSshFormInput): {
  readonly target: DesktopSshEnvironmentTarget;
  readonly credentials: MobileSshCredentials;
} {
  const host = input.host.trim();
  const username = input.username.trim();
  const key = input.privateKey.trim();
  const portText = input.port?.trim() ?? "";
  const port = portText === "" ? 22 : Number(portText);

  if (host.length === 0 || host.length > 255 || /[\s/@?#\\]/u.test(host) || host.startsWith("-")) {
    throw new Error("Enter an SSH host name or IP address, without a URL scheme.");
  }
  if (
    username.length === 0 ||
    /[\s@]/u.test(username) ||
    [...username].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Enter a valid SSH username.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH port must be a number from 1 to 65535.");
  }
  if (
    !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/u.test(key) &&
    !/^PuTTY-User-Key-File-[23]:/u.test(key)
  ) {
    throw new Error("Paste a supported SSH private key in OpenSSH, PEM, or PuTTY format.");
  }

  return {
    target: {
      alias: host,
      hostname: host,
      username,
      port: port === 22 ? null : port,
    },
    credentials: {
      host,
      port,
      username,
      privateKey: key,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    },
  };
}
