import { useEffect, useState } from "react";
import type { Task } from "../types";
import { ReplyImagePreview } from "./ReplyImagePreview";

type Image = { url: string; alt: string };
export function ImageGallery({ task, images, loadImage, onLightboxChange }: { task: Task; images: Image[]; loadImage: (task: Task, url?: string) => Promise<string | null>; onLightboxChange?: (opened: boolean) => void }) {
  const signature = JSON.stringify([task.id, task.turnId, images.map(image => image.url)]);
  const [loaded, setLoaded] = useState<{ signature: string; sources: (string | null)[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(images.map(image => loadImage(task, image.url).catch(() => null))).then(sources => {
      if (!cancelled) setLoaded({ signature, sources });
    });
    return () => { cancelled = true; };
  }, [signature, loadImage]);
  const sources = loaded?.signature === signature ? loaded.sources : null;
  return <div className="taskchef-prompt-images" aria-busy={!sources}>
    {images.map((image, index) => sources
      ? sources[index] && <ReplyImagePreview key={`${signature}:${index}`} task={task} url={image.url} alt={image.alt} loadImage={loadImage} source={sources[index]} onLightboxChange={onLightboxChange} />
      : <span key={image.url + index} className="taskchef-image-placeholder" role="status" aria-label={`Loading ${image.alt}`} />)}
  </div>;
}
