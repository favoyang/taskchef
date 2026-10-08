import { fromMarkdown } from 'mdast-util-from-markdown';
import { isAbsolute } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

// Parse actual Markdown image nodes, excluding code examples and raw HTML.
export function replyImage(text) {
  const tree = fromMarkdown(text);
  const definitions = new Map();
  const collect = (node) => { if (node.type === 'definition') definitions.set(node.identifier, node.url); for (const child of node.children ?? []) collect(child); };
  collect(tree);
  let image = null;
  const visit = (node) => {
    if (image) return;
    const url = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier) : null;
    if (typeof url === 'string' && (isAbsolute(url) && !url.startsWith('//') || /^https:\/\//i.test(url))) image = { url, alt: node.alt || 'Reply image' };
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return image;
}

// Read only the image referenced by the selected reply. Never accept a path
// supplied independently by the UI, fetch URLs, or serve active SVG content.
export async function localReplyImage(path) {
  if (!isAbsolute(path) || path.startsWith('//')) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const limit = 4 * 1024 * 1024;
    if (!info.isFile() || info.size > limit) return null;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) return null;
    const data = bytes.subarray(0, length);
    const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
        : /^GIF8[79]a$/.test(data.subarray(0,6).toString()) ? 'image/gif'
          : data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
    return mime ? `data:${mime};base64,${data.toString('base64')}` : null;
  } finally { await file.close(); }
}
