import { useEffect, useRef, useState } from "react";
import { IconBell, IconX } from "@tabler/icons-react";

export interface NextNotification { id: string; taskId: string | null; title: string; detail: string; kind: "ready" | "interrupted" | "confirmation" | "error"; read: boolean; timestamp: string; }
export interface NextNotificationState { revision: number; items: NextNotification[]; }
export function NextNotificationCenter({ state, toasts, onAction, onOpen, onDismiss }: {
  state: NextNotificationState; toasts: NextNotification[];
  onAction: (action: "read" | "read_all" | "clear", id?: string) => Promise<void>;
  onOpen: (item: NextNotification) => void; onDismiss: (id: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const unread = state.items.filter((item) => !item.read).length;
  const items = state.items.filter((item) => filter === "all" || !item.read);
  useEffect(() => {
    if (!opened) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpened(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpened(false); bell.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [opened]);
  async function mutate(action: "read" | "read_all" | "clear", id?: string) {
    setBusy(true);
    try { await onAction(action, id); } finally { setBusy(false); }
  }
  return <div className="next-notifications" ref={root}>
    <button ref={bell} className="next-icon-button" aria-label="Notifications" aria-expanded={opened} aria-controls="next-notification-panel" onClick={() => setOpened((value) => !value)} title={unread ? `${unread} unread notifications` : "Notifications"}>
      <IconBell size={18} />{unread > 0 && <span className="next-unread-count" aria-label={`${unread} unread`}>{unread}</span>}
    </button>
    {opened && <section id="next-notification-panel" className="next-notification-panel" aria-label="Notification center">
      <div className="next-notification-heading"><strong>Notifications</strong><button className="next-icon-button" aria-label="Close notifications" onClick={() => { setOpened(false); bell.current?.focus(); }}><IconX size={16} /></button></div>
      <div className="next-notification-controls">
        <div role="group" aria-label="Notification filter"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button><button aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>Unread{unread > 0 ? ` (${unread})` : ""}</button></div>
        <button disabled={busy || unread === 0} onClick={() => void mutate("read_all")}>Mark all read</button>
        <button disabled={busy || state.items.length === 0} onClick={() => void mutate("clear")}>Clear all</button>
      </div>
      <div className="next-notification-list">
        {items.length === 0 && <p className="next-notification-empty">{filter === "unread" ? "No unread notifications" : "No notifications yet"}</p>}
        {items.map((item) => <article key={item.id} className={`next-notification-item${item.read ? "" : " next-notification-unread"}`}>
          <button className="next-notification-message" disabled={busy} onClick={() => { void mutate("read", item.id); if (item.taskId) { setOpened(false); onOpen(item); } }}>
            <strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}<time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
          </button>
        </article>)}
      </div>
    </section>}
    <div className="next-toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => <article key={item.id} className={`next-toast next-toast-${item.kind}`}>
        <button className="next-toast-message" onClick={() => { if (item.taskId) onOpen(item); void mutate("read", item.id); onDismiss(item.id); }}><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}</button>
        <button className="next-icon-button" aria-label={`Dismiss ${item.title}`} onClick={() => onDismiss(item.id)}><IconX size={16} /></button>
      </article>)}
    </div>
  </div>;
}
