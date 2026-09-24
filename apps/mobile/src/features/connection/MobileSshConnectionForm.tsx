import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { ErrorBanner } from "../../components/ErrorBanner";
import { setMobileSshHostTrustDecision } from "../../ssh/manager";
import { useConnectionController } from "./useConnectionController";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionSheetButton } from "./ConnectionSheetButton";

export function MobileSshConnectionForm({ onConnected }: { readonly onConnected: () => void }) {
  const { connectSshEnvironment } = useConnectionController();
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const activeAttempt = useRef<AbortController | null>(null);

  useEffect(() => {
    setMobileSshHostTrustDecision(
      ({ host: keyHost, port: keyPort, key }) =>
        new Promise<boolean>((resolve) => {
          Alert.alert(
            "Trust SSH host?",
            `${keyHost}:${keyPort}\n${key.algorithm}\n${key.fingerprint}\n\nCheck this fingerprint with the host administrator before continuing.`,
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Trust host", onPress: () => resolve(true) },
            ],
            { cancelable: false },
          );
        }),
    );
    return () => {
      activeAttempt.current?.abort();
      setMobileSshHostTrustDecision(null);
    };
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    setCancelled(false);
    const controller = new AbortController();
    activeAttempt.current = controller;
    try {
      const result = await connectSshEnvironment({
        host,
        username,
        port,
        privateKey,
        passphrase,
        signal: controller.signal,
      });
      if (AsyncResult.isSuccess(result)) {
        setPrivateKey("");
        setPassphrase("");
        onConnected();
      } else {
        const cause = Cause.squash(result.cause);
        setError(cause instanceof Error ? cause.message : "Could not connect over SSH.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect over SSH.");
    } finally {
      if (activeAttempt.current === controller) activeAttempt.current = null;
      setSubmitting(false);
    }
  }, [
    connectSshEnvironment,
    host,
    onConnected,
    passphrase,
    port,
    privateKey,
    submitting,
    username,
  ]);

  return (
    <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
      <ConnectionFormField
        label="SSH host"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="server.example.com"
        value={host}
        onChangeText={setHost}
      />
      <ConnectionFormField
        label="Username"
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={setUsername}
      />
      <ConnectionFormField
        label="SSH port (optional)"
        keyboardType="number-pad"
        placeholder="22"
        value={port}
        onChangeText={setPort}
      />
      <ConnectionFormField
        label="Private key"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        numberOfLines={6}
        textAlignVertical="top"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        value={privateKey}
        onChangeText={setPrivateKey}
      />
      <ConnectionFormField
        label="Key passphrase (optional)"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        value={passphrase}
        onChangeText={setPassphrase}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <View className="flex-row justify-end gap-2">
        {submitting ? (
          <ConnectionSheetButton
            icon="xmark"
            label="Cancel"
            disabled={cancelled}
            onPress={() => {
              setCancelled(true);
              activeAttempt.current?.abort();
            }}
          />
        ) : null}
        <ConnectionSheetButton
          icon="plus"
          label={submitting ? "Connecting..." : "Add SSH environment"}
          disabled={submitting}
          tone="primary"
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
