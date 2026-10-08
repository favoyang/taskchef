import { useEffect, useRef, useState } from "react";
import type { Task } from "../types";

export function ReplyCover({ task, loadImage, onOpen }: { task: Task; loadImage?: (task: Task) => Promise<string | null>; onOpen: () => void }) {
  const image = task.replyImage!;
  const root = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let started = false;
    setSrc(null); setFailed(false);
    const load = async () => {
      if (started) return;
      started = true;
      try {
        const url = /^https:\/\//i.test(image.url) ? image.url : await loadImage?.(task);
        if (!cancelled) { setSrc(url || null); setFailed(!url); }
      } catch { if (!cancelled) setFailed(true); }
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void load(); }
    }, { rootMargin: "200px" });
    if (observer && root.current) observer.observe(root.current); else void load();
    return () => { cancelled = true; observer?.disconnect(); };
  }, [image.url, task.turnId, loadImage]);
  return <button ref={root} type="button" className="taskchef-reply-cover" aria-label={`View image details for ${task.title}`} onClick={onOpen}>
    {src && !failed ? <img src={src} alt={image.alt} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />
      : <span>{failed ? "Image unavailable" : "Loading image…"}</span>}
  </button>;
}
