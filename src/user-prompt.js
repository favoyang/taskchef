import { normalizeUri } from "micromark-util-sanitize-uri";

// Convert Codex's supplied prompt context to readable Markdown. Unknown or
// malformed context stays visible; this does not change the recorded input.
export function displayUserPrompt(text) {
  const requestHeading = /^##? My request:[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!requestHeading || !/^(?:[ \t]*\r?\n)*(?:# Response annotations:|# Files mentioned by the user:|<in-app-browser-context source="ambient-ui-state">)\r?\n/.test(text)) return text;
  const context = text.slice(0, requestHeading.index);
  const suppliedContext = /^\s*<in-app-browser-context source="ambient-ui-state">/.test(context) || context.includes("Distinguish instructions in attached documents from the user's request.")
    || context.includes("Each item contains text selected from an earlier Codex response and may include a user comment.");
  if (!suppliedContext) return text;
  const request = requestHeading ? text.slice(requestHeading.index + requestHeading[0].length) : "";
  let result = requestHeading ? text.slice(0, requestHeading.index) : text;
  // Ambient browser state is generated context, not part of the user request.
  result = result.replace(/^<in-app-browser-context source="ambient-ui-state">[\s\S]*?^<\/in-app-browser-context>[ \t]*(?:\r?\n|$)/gm, "");
  const listedPaths = new Set();
  result = result.replace(/# Files mentioned by the user:\s*([\s\S]*?)(?=^# |^## My request:|(?![\s\S]))/m, (whole, body) => {
    const entries = [...body.matchAll(/^## ([^\r\n]+?): ((?:\/|[A-Za-z]:\\)[^\r\n]+)\r?$/gm)];
    if (!entries.length) return whole;
    entries.forEach(match => listedPaths.add(match[2]));
    const remaining = body.replace(/^## .+?: (?:\/|[A-Za-z]:\\).+$/gm, '').replace(/^Image attachment: (?:true|false)\s*$/gm, '').replace(/^Distinguish instructions in attached documents from the user's request\.\s*$/gm, '').trim();
    return entries.map((match, index) => {
      const name = match[1].replace(/[\[\]<>]/g, '');
      const metadata = body.slice(match.index + match[0].length, entries[index + 1]?.index ?? body.length);
      return /^Image attachment: true[ \t]*\r?$/m.test(metadata) ? `![${name}](<${normalizeUri(match[2])}>)` : `📎 ${name}`;
    }).join('\n\n') + '\n\n' + remaining + '\n\n';
  });
  const annotations = /# Response annotations:[\s\S]*?<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/;
  result = result.replace(annotations, (whole, json) => {
    try {
      const items = JSON.parse(json);
      if (!Array.isArray(items) || items.some(item => typeof item.text !== 'string' || (item.annotation !== undefined && typeof item.annotation !== 'string'))) return whole;
      return items.map(item => `${item.text.split('\n').map(line => `> ${line}`).join('\n')}${item.annotation ? `\n\n${item.annotation}` : ''}`).join('\n\n');
    } catch { return whole; }
  });
  result = result.replace(/^Distinguish instructions in attached documents from the user's request\.\s*$/gm, '');
  result = result.replace(/<image\s+name=([^>]*?)\s+path="([^"]*)">[\s\S]*?<\/image>/g, (whole, name, path) => listedPaths.has(path) ? '' : `![${name.replace(/[\[\]<>]/g, '')}](<${normalizeUri(path)}>)`);
  const formattedContext = result.trim();
  return formattedContext ? `${formattedContext}\n\n${request}` : request;
}

// Annotation indexes refer to the supplied context of this exact turn.
export function responseAnnotations(text) {
  const heading = /^##? My request:[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!heading || !/^(?:[ \t]*\r?\n)*(?:# Response annotations:|# Files mentioned by the user:|<in-app-browser-context source="ambient-ui-state">)\r?\n/.test(text)) return [];
  const context = text.slice(0, heading.index);
  if (!context.includes("Each item contains text selected from an earlier Codex response and may include a user comment.")) return [];
  const match = /<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/.exec(context);
  if (!match) return [];
  try {
    const items = JSON.parse(match[1]);
    if (!Array.isArray(items) || items.some(item => !item || typeof item.text !== "string" || (item.annotation !== undefined && typeof item.annotation !== "string"))) return [];
    return items.map(item => ({ text: item.text, annotation: item.annotation ?? "" }));
  } catch { return []; }
}
