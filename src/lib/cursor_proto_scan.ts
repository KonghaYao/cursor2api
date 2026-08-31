/**
 * 从 Connect / Cursor 自定义帧流中扫描生图结果（PNG magic、imageData JSON）
 */
export function scanStreamForImage(raw: Uint8Array | Buffer): {
  pngMagic: boolean;
  imageDataBase64?: string;
} {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const pngMagic =
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const m =
    text.match(/"imageData"\s*:\s*"([A-Za-z0-9+/=\r\n]{500,})"/) ||
    text.match(/"image_data"\s*:\s*"([A-Za-z0-9+/=\r\n]{500,})"/);
  if (m) {
    const imageDataBase64 = m[1]!.replace(/\s+/g, "");
    return { pngMagic: pngMagic || imageDataBase64.startsWith("iVBOR"), imageDataBase64 };
  }
  return { pngMagic };
}

export function extractPngFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
