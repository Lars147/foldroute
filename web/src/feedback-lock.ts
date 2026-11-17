/** Shared order: backup access, feedback access, then IndexedDB transactions. */
export function feedbackLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return action();
  return navigator.locks.request("foldroute-feedback", action);
}
