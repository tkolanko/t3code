# Mobile SSH

Quick context for changing how the mobile app reaches a T3 server over SSH. Read
this before touching `apps/mobile/src/ssh/`. User-facing setup lives in
[remote access](../../../../docs/user/remote-access.md#mobile-ssh); the shared
remote model lives in [remote internals](../../../../docs/internals/remote.md).

## Shape

The phone opens an SSH session with a pasted private key, makes sure a T3 server
is running on the host, and forwards a local loopback port to it. From then on
the client treats it like any bearer-token environment at
`http://127.0.0.1:<localPort>/`.

- **Transport** is `@osuki-dev/react-native-ssh` (russh in Rust, wrapped in
  Nitro). There is no system `ssh`, no `~/.ssh/config`, no agent, no
  ControlMaster. Library keepalive defaults are 15s × 3, so a dead socket can
  still report `isConnected` for about 45s.
- **Remote scripts** are shared with desktop through
  `@t3tools/ssh/remoteBootstrap` (`buildRemoteLaunchScript`,
  `buildRemotePairingScript`). The launch script installs the pinned CLI archive
  into `~/.t3/runtime/versions/<version>`, reuses a running server (the host's
  own `~/.t3` server counts as `external`), or starts one with `nohup`. The
  version is the `apps/server` version, baked into `extra.sshCliVersion` by
  `app.config.ts`, so the app and the remote runtime ship in lockstep.
- **Scripts go over stdin** to `sh -s` through `openShell`, not `exec`, so script
  size and quoting do not matter.

| File           | Owns                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `transport.ts` | One SSH connection: `runScript`, `forwardLoopback`, `close`.                                             |
| `manager.ts`   | One tunnel entry per target, reconnect ladder, host key trust, pairing script.                           |
| `gateway.ts`   | `SshEnvironmentGateway` for client-runtime: `provision` (onboarding), `prepare` (every connect), errors. |
| `secrets.ts`   | SecureStore: credentials and bearer token per connection ID, pinned host key per host and port.          |
| `cleanup.ts`   | What to disconnect or forget when the connection catalog replaces or removes an SSH profile.             |
| `input.ts`     | Form validation into a `DesktopSshEnvironmentTarget` plus credentials.                                   |

The SSH-agnostic parts live in client-runtime: the broker in
`packages/client-runtime/src/connection/resolver.ts` calls `prepare`, and
`registry.ts` calls `disconnect` only when an environment is removed or switched
off. Dropping a WebSocket lease never closes the SSH session.

## Onboarding vs. reconnect

**Onboarding (`provision`)** stages credentials in memory, pairs through the
pairing script (`t3 auth pairing create`), exchanges the pairing credential for a
bearer token, then saves both credentials and bearer token under
`ssh:<environmentId>`. If onboarding fails after saving, the staging logic in
`gateway.ts` restores or removes the key unless the catalog already committed.

**Reconnect (`prepare`)** runs on every connect attempt. On mobile that means on
every resume after 10s in the background, because
`MOBILE_BACKGROUND_RECONNECT_AFTER_MS` makes the supervisor replace the lease
(the OS usually suspends sockets without a close event). So `prepare` must be
cheap in the common case. It tries these in order:

1. Existing entry passes the health check: reuse it.
2. Session still connected, forward dead: open a new forward on the same session
   to the last remote port.
3. Session dead: open a new session and forward to the last remote port. No
   launch script.
4. Last port does not answer: open a **fresh** session and run the launch
   script. A session that claims to be connected but does not answer may be
   half-dead after suspension, and `openShell` on it can hang.
5. With a tunnel in hand, check the saved bearer token with `/api/auth/session`.
   Only pair again if it is rejected, then save the new token.

The health check fetches `/.well-known/t3/environment` with a 2s timeout, so a
reused port is proven to be a T3 server. The environment ID itself is checked
later by `authorizeBearer`.

## Why it is built this way

- **Pairing is expensive.** It opens a remote shell, cold-starts the `t3`
  binary, and opens the host's auth store. Doing it on every resume was the main
  source of slow reconnects, and it minted a new paired client each time. That
  is why the bearer token is cached.
- **The remote server outlives the SSH session.** It runs under `nohup`, and
  clients catch up by event sequence, so losing the transport loses no state.
  Reconnecting is only about rebuilding the pipe, like Mosh's server-side
  session.
- **The local forward is a listening socket.** iOS may reclaim listening sockets
  while an app is suspended (Apple TN2277), so the forward can die while the SSH
  session survives. Hence step 2. This is inferred from Apple's docs and not yet
  confirmed on a device.
- **Only the launch script uses a login shell.** `sh -l` sources the user's
  profile, which can cost seconds with nvm, conda, or brew. The launch script
  needs it to find `curl`, `wget`, or `node`. Pairing runs plain `sh -s`,
  matching desktop in `packages/ssh/src/tunnel.ts`.
- **Closing a dead session is bounded to 1s.** A disconnect on a half-dead socket
  can block, and it must never hold up the replacement.
- **Host keys are pinned per host and port**, with the pinned algorithm
  preferred on connect. A changed key is a `ConnectionBlockedError`, never a
  silent re-trust.

## Traps

- The last remote port is **in memory only** (`lastRemote` in `manager.ts`). A
  cold app start always runs the launch script once. It survives failed attempts
  so a network drop does not lose it, and `disconnectMobileSshEnvironment`
  clears it.
- `removeCredentials` also deletes the bearer token. Anything that forgets an SSH
  connection should go through it rather than deleting keys directly.
- Two target keys exist: `manager.ts` keys by alias, hostname, username, and port,
  while `gateway.ts` staging keys by hostname, username, and port (default 22).
  Keep them in step if the target shape changes.
- `connectTimeoutMs` is 30s. If the network is not up yet on resume, the first
  attempt can sit for that long before the supervisor retries.
- The script timeout is 15 minutes because the first launch may download the
  archive. A hung shell on a dead session would wait that long, which is why
  step 4 never runs the launch script on a suspect session.
- Desktop pairs on every `prepare` too (`apps/web/src/connection/platform.ts`).
  It reconnects rarely, so it has not needed the bearer cache.

## Not done yet

- `beginBackgroundTask` on iOS to survive quick app switches. It needs a native
  module.
- An Android foreground service to keep the session alive in the background.
- Persisting the last remote port so a cold start can skip the launch script.
- Timing logs per phase (connect, launch, forward, health, pairing, auth), to
  confirm on a device which ladder step a resume lands in.

## Tests

`vp test run apps/mobile/src/ssh` covers the manager ladder (`manager.test.ts`),
bearer reuse and re-pairing (`gateway.test.ts`), secret storage, cleanup, input
parsing, and cancellation. The manager tests mock `transport.ts`, and the
gateway tests mock the manager, so behavior on a real device still needs a pass
with `test-t3-mobile`.
