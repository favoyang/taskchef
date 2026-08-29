const DEFAULT_PARENT_CHECK_INTERVAL_MS = 1_000;

export function installParentLossMonitor({
  onParentLoss,
  parentPid = process.ppid,
  readParentPid = () => process.ppid,
  intervalMs = DEFAULT_PARENT_CHECK_INTERVAL_MS,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  if (typeof onParentLoss !== "function") throw new Error("parent-loss callback is required");
  let stopped = false;
  let notified = false;
  const check = () => {
    if (stopped || notified || readParentPid() === parentPid) return;
    notified = true;
    void Promise.resolve().then(onParentLoss).catch(() => {});
  };
  const timer = schedule(check, intervalMs);
  timer.unref?.();
  return {
    check,
    close() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    },
  };
}
