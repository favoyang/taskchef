export const MAX_NOTIFICATIONS = 50;

export function taskSignature(task) {
  return JSON.stringify([
    task.threadId,
    task.status,
    task.summary,
    task.turnId,
    task.updatedAt,
    task.updatedBy,
  ]);
}

export function findCurrentTask(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) ?? null;
}

export function reconcileNotifications(
  { initialized, notifications, signatures },
  tasks,
  revision,
) {
  const nextSignatures = new Map(tasks.map((task) => [task.id, taskSignature(task)]));
  if (!initialized) return { notifications, signatures: nextSignatures };
  const additions = [];
  for (const task of tasks) {
    let kind = null;
    if (!signatures.has(task.id)) kind = "new";
    else if (signatures.get(task.id) !== nextSignatures.get(task.id)) kind = "changed";
    if (kind) additions.push({
      id: `${revision}:${task.id}`,
      kind,
      taskId: task.id,
    });
  }
  return {
    notifications: [...additions, ...notifications].slice(0, MAX_NOTIFICATIONS),
    signatures: nextSignatures,
  };
}
