/** Cursor InferenceContentPart: text | image | file. data is raw base64, not a data URL. */

export const MAX_CURSOR_MEDIA_BYTES = 10 * 1024 * 1024;
/** @deprecated use MAX_CURSOR_MEDIA_BYTES */
export const MAX_CURSOR_IMAGE_BYTES = MAX_CURSOR_MEDIA_BYTES;

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

export type CursorMediaBytes = { data: string; mimeType: string };
export type CursorImageBytes = CursorMediaBytes;

export type MediaResolveOpts = {
  fetch?: typeof fetch;
};

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64DecodedBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function assertMediaSize(decodedBytes: number): void {
  if (decodedBytes > MAX_CURSOR_MEDIA_BYTES) {
    throw new ImageInputError(`Media input is too large (max ${MAX_CURSOR_MEDIA_BYTES} bytes)`);
  }
}

/** Parse `data:<mime>;base64,...` into Cursor image/file data fields. */
export function parseDataUrl(url: string): CursorMediaBytes | null {
  const trimmed = url.trim();
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(trimmed);
  if (!m) return null;
  const mimeType = (m[1] || "application/octet-stream").trim().toLowerCase() || "application/octet-stream";
  if (!m[2]) return null;
  const data = (m[3] || "").replace(/\s+/g, "");
  if (!data) return null;
  assertMediaSize(base64DecodedBytes(data));
  return { data, mimeType };
}

export function parseImageDataUrl(url: string): CursorImageBytes | null {
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  if (parsed.mimeType && !parsed.mimeType.startsWith("image/") && parsed.mimeType !== "application/octet-stream") {
    return parsed;
  }
  return { data: parsed.data, mimeType: parsed.mimeType.startsWith("image/") ? parsed.mimeType : "image/png" };
}

export async function resolveCursorMedia(
  url: string,
  fetchImpl: typeof fetch = fetch,
  fallbackMime = "application/octet-stream",
): Promise<CursorMediaBytes> {
  const fromData = parseDataUrl(url);
  if (fromData) return fromData;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageInputError("Invalid media URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImageInputError("Media URL must be a data: URI or http(s) URL");
  }

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(15_000)
      : undefined;
  let res: Response;
  try {
    res = await fetchImpl(parsed, { redirect: "follow", signal });
  } catch (err) {
    throw new ImageInputError(`Failed to fetch media: ${String((err as Error)?.message || err)}`);
  }
  if (!res.ok) throw new ImageInputError(`Failed to fetch media (${res.status})`);
  const mime = (res.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || fallbackMime;
  const buf = new Uint8Array(await res.arrayBuffer());
  assertMediaSize(buf.length);
  if (!buf.length) throw new ImageInputError("Media input is empty");
  return { data: bytesToBase64(buf), mimeType: mime || fallbackMime };
}

export async function resolveCursorImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorImageBytes> {
  const media = await resolveCursorMedia(url, fetchImpl, "image/png");
  return {
    data: media.data,
    mimeType: media.mimeType.startsWith("image/") ? media.mimeType : "image/png",
  };
}

function rec(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== "object") return null;
  return part as Record<string, unknown>;
}

export function extractOpenAiImageUrl(part: Record<string, unknown>): string | undefined {
  const type = String(part.type || "").toLowerCase();
  if (type === "image_url" || type === "input_image") {
    const iu = part.image_url ?? part.imageUrl ?? part.url;
    if (typeof iu === "string" && iu) return iu;
    if (iu && typeof iu === "object") {
      const url = (iu as Record<string, unknown>).url;
      if (typeof url === "string" && url) return url;
    }
  }
  if (type === "image") {
    const source = part.source as Record<string, unknown> | undefined;
    if (source && typeof source === "object") {
      const st = String(source.type || "").toLowerCase();
      if (st === "base64" && typeof source.data === "string" && source.data) {
        const mime = String(source.media_type || source.mediaType || "image/png");
        return `data:${mime};base64,${source.data}`;
      }
      if ((st === "url" || st === "image_url") && typeof source.url === "string") return source.url;
    }
    if (typeof part.image_url === "string" && part.image_url) return String(part.image_url);
  }
  return undefined;
}

export function extractOpenAiFile(
  part: Record<string, unknown>,
): { url?: string; data?: string; mimeType?: string; filename?: string } | undefined {
  const type = String(part.type || "").toLowerCase();
  if (type !== "file" && type !== "input_file") return undefined;
  const file = (part.file && typeof part.file === "object" ? part.file : part) as Record<string, unknown>;
  const filename = String(file.filename || part.filename || "file");
  const fileData = file.file_data ?? file.fileData ?? part.file_data ?? part.fileData;
  if (typeof fileData === "string" && fileData) {
    return { url: fileData.startsWith("data:") ? fileData : undefined, data: fileData, filename };
  }
  const url = file.file_url ?? file.fileUrl ?? file.url ?? part.file_url;
  if (typeof url === "string" && url) return { url, filename };
  return { filename };
}

export function isOpenAiImagePart(part: Record<string, unknown>): boolean {
  const type = String(part.type || "").toLowerCase();
  return type === "image_url" || type === "input_image" || type === "image";
}

export function isOpenAiFilePart(part: Record<string, unknown>): boolean {
  const type = String(part.type || "").toLowerCase();
  return type === "file" || type === "input_file";
}

export function isAnthropicImagePart(part: Record<string, unknown>): boolean {
  return String(part.type || "").toLowerCase() === "image";
}

export function isAnthropicDocumentPart(part: Record<string, unknown>): boolean {
  const type = String(part.type || "").toLowerCase();
  return type === "document" || type === "file";
}

function imagePartJson(media: CursorMediaBytes): Record<string, unknown> {
  return { image: { data: media.data, mimeType: media.mimeType } };
}

function filePartJson(media: CursorMediaBytes, filename?: string): Record<string, unknown> {
  const file: Record<string, unknown> = { data: media.data, mediaType: media.mimeType };
  if (filename) file.filename = filename;
  return { file };
}

async function mediaFromRawBase64(
  data: string,
  mimeType: string,
): Promise<CursorMediaBytes> {
  const clean = data.replace(/\s+/g, "");
  assertMediaSize(base64DecodedBytes(clean));
  return { data: clean, mimeType: mimeType || "application/octet-stream" };
}

async function resolveImageFromPart(
  part: Record<string, unknown>,
  opts?: MediaResolveOpts,
): Promise<Record<string, unknown>> {
  const url = extractOpenAiImageUrl(part);
  if (!url) throw new ImageInputError("Image part is missing a url or base64 data");
  const img = await resolveCursorImage(url, opts?.fetch ?? fetch);
  return imagePartJson(img);
}

async function resolveFileFromPart(
  part: Record<string, unknown>,
  opts?: MediaResolveOpts,
): Promise<Record<string, unknown>> {
  const info = extractOpenAiFile(part);
  if (!info) throw new ImageInputError("File part is missing data");
  if (info.url) {
    const media = await resolveCursorMedia(info.url, opts?.fetch ?? fetch, "application/octet-stream");
    return filePartJson(media, info.filename);
  }
  if (info.data?.startsWith("data:")) {
    const media = parseDataUrl(info.data);
    if (!media) throw new ImageInputError("Invalid file data URL");
    return filePartJson(media, info.filename);
  }
  if (info.data) {
    const mime = info.mimeType || "application/octet-stream";
    const media = await mediaFromRawBase64(info.data, mime);
    return filePartJson(media, info.filename);
  }
  throw new ImageInputError("File part is missing data");
}

async function resolveAnthropicImage(
  part: Record<string, unknown>,
  opts?: MediaResolveOpts,
): Promise<Record<string, unknown>> {
  const source = rec(part.source) || part;
  const st = String(source.type || "").toLowerCase();
  if (st === "base64" && typeof source.data === "string") {
    const mime = String(source.media_type || source.mediaType || "image/png");
    const media = await mediaFromRawBase64(source.data, mime);
    return imagePartJson({
      data: media.data,
      mimeType: media.mimeType.startsWith("image/") ? media.mimeType : "image/png",
    });
  }
  if ((st === "url" || st === "image_url") && typeof source.url === "string") {
    const img = await resolveCursorImage(source.url, opts?.fetch ?? fetch);
    return imagePartJson(img);
  }
  return resolveImageFromPart(part, opts);
}

async function resolveAnthropicDocument(
  part: Record<string, unknown>,
  opts?: MediaResolveOpts,
): Promise<Record<string, unknown>> {
  const source = rec(part.source) || part;
  const filename = String(part.title || part.filename || source.filename || "document");
  const st = String(source.type || "").toLowerCase();
  if (st === "base64" && typeof source.data === "string") {
    const mime = String(source.media_type || source.mediaType || "application/pdf");
    const media = await mediaFromRawBase64(source.data, mime);
    return filePartJson(media, filename);
  }
  if (st === "url" && typeof source.url === "string") {
    const media = await resolveCursorMedia(source.url, opts?.fetch ?? fetch, "application/pdf");
    return filePartJson(media, filename);
  }
  return resolveFileFromPart(part, opts);
}

export type CursorContentParts = {
  parts: Array<Record<string, unknown>>;
  hasMedia: boolean;
  text: string;
};

/** Convert OpenAI or mixed content array into Cursor InferenceContentPart list. */
export async function openaiContentToCursorParts(
  content: unknown,
  opts?: MediaResolveOpts,
): Promise<CursorContentParts> {
  if (!Array.isArray(content)) {
    const text = typeof content === "string" ? content : content == null ? "" : String(content);
    return { parts: text ? [{ text: { text } }] : [], hasMedia: false, text };
  }
  const parts: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  let hasMedia = false;
  for (const part of content) {
    if (typeof part === "string") {
      if (part) {
        parts.push({ text: { text: part } });
        texts.push(part);
      }
      continue;
    }
    const p = rec(part);
    if (!p) continue;
    if (isOpenAiImagePart(p)) {
      parts.push(await resolveImageFromPart(p, opts));
      hasMedia = true;
      continue;
    }
    if (isOpenAiFilePart(p)) {
      parts.push(await resolveFileFromPart(p, opts));
      hasMedia = true;
      continue;
    }
    if (p.type === "thinking") continue;
    const text = p.type === "text" || typeof p.text === "string" ? String(p.text || "") : "";
    if (text) {
      parts.push({ text: { text } });
      texts.push(text);
    }
  }
  return { parts, hasMedia, text: texts.filter(Boolean).join("\n") };
}

/** Convert Anthropic content blocks (user/tool_result inner content). */
export async function anthropicContentToCursorParts(
  content: unknown,
  opts?: MediaResolveOpts,
): Promise<CursorContentParts> {
  if (typeof content === "string" || content == null || !Array.isArray(content)) {
    const text = typeof content === "string" ? content : content == null ? "" : String(content);
    return { parts: text ? [{ text: { text } }] : [], hasMedia: false, text };
  }
  const parts: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  let hasMedia = false;
  for (const part of content) {
    if (typeof part === "string") {
      if (part) {
        parts.push({ text: { text: part } });
        texts.push(part);
      }
      continue;
    }
    const p = rec(part);
    if (!p) continue;
    if (isAnthropicImagePart(p) || isOpenAiImagePart(p)) {
      parts.push(await resolveAnthropicImage(p, opts));
      hasMedia = true;
      continue;
    }
    if (isAnthropicDocumentPart(p) || isOpenAiFilePart(p)) {
      parts.push(await resolveAnthropicDocument(p, opts));
      hasMedia = true;
      continue;
    }
    if (p.type === "text" || typeof p.text === "string") {
      const text = String(p.text || "");
      if (text) {
        parts.push({ text: { text } });
        texts.push(text);
      }
    }
  }
  return { parts, hasMedia, text: texts.filter(Boolean).join("\n") };
}

export type CursorToolResultPart = {
  toolCallId: unknown;
  toolName: string;
  result: string;
  isError: boolean;
  experimentalContent?: Array<Record<string, unknown>>;
};

export async function contentToToolResultPart(
  toolCallId: unknown,
  toolName: string,
  content: unknown,
  isError: boolean,
  opts?: MediaResolveOpts,
): Promise<CursorToolResultPart> {
  const converted = await anthropicContentToCursorParts(content, opts);
  const out: CursorToolResultPart = {
    toolCallId,
    toolName,
    result: converted.text || (converted.hasMedia ? "" : String(content ?? "")),
    isError,
  };
  if (converted.hasMedia) {
    out.experimentalContent = converted.parts;
    if (!converted.text) out.result = "";
  }
  return out;
}

export function userMessageFromParts(
  role: string,
  converted: CursorContentParts,
): Record<string, unknown> {
  if (!converted.hasMedia) return { role, text: converted.text };
  return { role, parts: { parts: converted.parts } };
}

export function countCursorMediaParts(messages: Array<Record<string, unknown>>): {
  images: number;
  files: number;
} {
  let images = 0;
  let files = 0;
  for (const m of messages || []) {
    const parts = (m.parts as { parts?: unknown[] } | undefined)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const p = rec(part);
        if (!p) continue;
        if (p.image) images += 1;
        if (p.file) files += 1;
      }
    }
    const toolParts = (m.toolContent as { parts?: Array<Record<string, unknown>> } | undefined)?.parts;
    if (!Array.isArray(toolParts)) continue;
    for (const tp of toolParts) {
      const exp = tp.experimentalContent as unknown[] | undefined;
      if (!Array.isArray(exp)) continue;
      for (const part of exp) {
        const p = rec(part);
        if (!p) continue;
        if (p.image) images += 1;
        if (p.file) files += 1;
      }
    }
  }
  return { images, files };
}

export function countCursorImageParts(messages: Array<Record<string, unknown>>): number {
  return countCursorMediaParts(messages).images;
}
