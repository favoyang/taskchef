import { Modal } from "@mantine/core";
import { useEffect, useState } from "react";
import type { Task } from "../types";

export function ReplyImagePreview({ task, url, alt, loadImage, onLightboxChange }: { task: Task; url: string; alt: string; loadImage: (task: Task, url?: string) => Promise<string | null>; onLightboxChange?: (opened: boolean) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadImage(task, url).then(value => {
      if (!cancelled && value && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) setSrc(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [task.id, task.turnId, url, loadImage]);
  useEffect(() => {
    if (!opened) return;
    onLightboxChange?.(true);
    return () => onLightboxChange?.(false);
  }, [opened, onLightboxChange]);
  if (!src || failed) return null;
  return <span className="taskchef-response-image">
    <button type="button" className="taskchef-image-thumbnail" aria-label={`Enlarge ${alt}`} onClick={() => setOpened(true)}><img src={src} alt={alt} onError={() => setFailed(true)} /></button>
    <Modal opened={opened} onClose={() => setOpened(false)} title={alt} centered size="auto" zIndex={400} classNames={{ content: "taskchef-image-lightbox" }}>
      <img src={src} alt={alt} onError={() => { setFailed(true); setOpened(false); }} />
    </Modal>
  </span>;
}
