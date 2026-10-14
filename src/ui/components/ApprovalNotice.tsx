import { IconArrowUpRight, IconShieldCheck } from "@tabler/icons-react";
import type { Task } from "../types";

export function ApprovalCover({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const request = task.pendingApprovals?.[0];
  return <button type="button" className="taskchef-approval-cover" aria-label={`Open chat to approve for ${task.title}`} onClick={onOpen}>
    <span className="taskchef-approval-heading"><IconShieldCheck size={17} aria-hidden />Needs approval</span>
    <span className="taskchef-approval-preview">{request?.message ?? "Codex needs permission to continue."}</span>
    <span className="taskchef-approval-link">Open chat to approve<IconArrowUpRight size={14} aria-hidden /></span>
  </button>;
}

export function ApprovalPanel({ task, busy, onOpen }: { task: Task; busy: boolean; onOpen: () => void }) {
  return <section className="taskchef-approval-panel" aria-label="Pending approvals">
    <div className="taskchef-approval-heading"><IconShieldCheck size={17} aria-hidden />Permission required</div>
    {task.pendingApprovals?.length ? task.pendingApprovals.map(request => <div className="taskchef-approval-request" key={request.id}>
      <div className="taskchef-approval-title">{request.title}</div>
      <p>{request.message}</p>
      {request.origin && <div className="taskchef-approval-origin">Origin: {request.origin}</div>}
    </div>) : <p>Codex needs permission to continue.</p>}
    <p className="taskchef-approval-guidance">Open the chat to review this request and allow or deny it.</p>
    <button type="button" disabled={busy} className="taskchef-approval-action" onClick={onOpen}>Open chat to approve<IconArrowUpRight size={14} aria-hidden /></button>
  </section>;
}
