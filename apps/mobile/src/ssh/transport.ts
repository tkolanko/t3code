import {
  connect,
  type SshConnection,
  type SshHostKey,
  type SshLocalForward,
} from "@osuki-dev/react-native-ssh";

import { throwIfSshAborted } from "./abort";

export interface MobileSshCredentials {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string;
}

export interface MobileSshSession {
  readonly connection: SshConnection;
  readonly runScript: (
    script: string,
    args?: readonly string[],
    signal?: AbortSignal,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly forwardLoopback: (remotePort: number) => Promise<SshLocalForward>;
  readonly close: () => Promise<void>;
}

const SCRIPT_TIMEOUT_MS = 900_000;
const MAX_SCRIPT_OUTPUT_BYTES = 128 * 1024;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function openMobileSshSession(
  credentials: MobileSshCredentials,
  verifyHostKey: (key: SshHostKey) => Promise<boolean>,
  pinnedHostKeyAlgorithm?: string,
  signal?: AbortSignal,
): Promise<MobileSshSession> {
  throwIfSshAborted(signal);
  const connection = await connect({
    host: credentials.host,
    port: credentials.port,
    username: credentials.username,
    auth: {
      type: "privateKey",
      privateKey: credentials.privateKey,
      ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
    },
    verifyHostKey,
    ...(pinnedHostKeyAlgorithm ? { hostKeyAlgorithms: [pinnedHostKeyAlgorithm] } : {}),
    signal,
    connectTimeoutMs: 30_000,
  });

  const forwards = new Set<SshLocalForward>();
  return {
    connection,
    runScript: async (script, args = [], runSignal) => {
      if (runSignal?.aborted) {
        throw new Error("SSH command was cancelled.");
      }
      const stdout = new TextDecoder();
      const stderr = new TextDecoder();
      let out = "";
      let err = "";
      let outputBytes = 0;
      let resolveClosed!: (exitCode: number | undefined) => void;
      const closed = new Promise<number | undefined>((resolve) => {
        resolveClosed = resolve;
      });
      const command = ["sh", "-l", "-s", "--", ...args.map(shellQuote)].join(" ");
      const shell = await connection.openShell(
        { term: "", command },
        {
          onData: (data) => {
            outputBytes += data.byteLength;
            if (outputBytes <= MAX_SCRIPT_OUTPUT_BYTES)
              out += stdout.decode(data, { stream: true });
          },
          onStderr: (data) => {
            outputBytes += data.byteLength;
            if (outputBytes <= MAX_SCRIPT_OUTPUT_BYTES)
              err += stderr.decode(data, { stream: true });
          },
          onClosed: resolveClosed,
        },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => void shell.close().catch(() => undefined);
      runSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        shell.write(script);
        shell.sendEof();
        const exitCode = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("SSH command timed out.")),
              SCRIPT_TIMEOUT_MS,
            );
          }),
        ]);
        if (runSignal?.aborted) throw new Error("SSH command was cancelled.");
        if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES)
          throw new Error("SSH command output was too large.");
        out += stdout.decode();
        err += stderr.decode();
        if (exitCode !== 0) {
          throw new Error(err.trim() || `SSH command failed (exit ${String(exitCode)}).`);
        }
        return { stdout: out, stderr: err };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        runSignal?.removeEventListener("abort", onAbort);
        await shell.close();
      }
    },
    forwardLoopback: async (remotePort) => {
      const forward = await connection.forwardLocal({
        bindAddress: "127.0.0.1",
        localPort: 0,
        remoteHost: "127.0.0.1",
        remotePort,
      });
      forwards.add(forward);
      return forward;
    },
    close: async () => {
      await Promise.allSettled([...forwards].map((forward) => forward.close()));
      forwards.clear();
      await connection.disconnect();
    },
  };
}
