export function applyMalformedBoundaryPreview(tasks, taskId) {
  const task = tasks.find((candidate) => candidate.id === taskId);
  const turn = task?.turns?.[0];
  if (task && turn) {
    turn.startedAt = "not-a-timestamp";
    task.latestTurn = turn;
  }
  return tasks;
}
