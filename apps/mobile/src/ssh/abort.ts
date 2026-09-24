export function throwIfSshAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("SSH connection was cancelled.");
  error.name = "AbortError";
  throw error;
}
