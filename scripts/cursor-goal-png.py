#!/usr/bin/env python3
"""Cursor Inference tool_call → 本地执行 generate_image → 写出 PNG"""
import base64
import json
import os
import struct
import subprocess
import sys
import zlib
from pathlib import Path


def png_rgb(width: int, height: int, r: int, g: int, b: int) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes([r, g, b]) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    root = Path(os.environ.get("CURSOR_WORKSPACE", os.getcwd()))
    out_path = root / "assets" / "cursor-goal-red.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    gw = Path(__file__).resolve().parents[1]
    node = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            """
import { generateImage } from './src/lib/cursor_generate_image.ts';
const r = await generateImage({
  description: 'solid bright red 64x64 square, no text',
  filePath: 'assets/cursor-goal-red.png',
  mode: 'inference',
  tryContinue: false,
});
console.log(JSON.stringify({ toolCall: r.toolCall, conversationId: r.conversationId }));
""",
        ],
        cwd=gw,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if node.returncode != 0:
        print(json.dumps({"ok": False, "error": node.stderr or node.stdout}))
        sys.exit(1)
    meta = json.loads(node.stdout.strip().split("\n")[-1])
    args = json.loads(meta["toolCall"]["args"]) if meta.get("toolCall") else {}
    rel = args.get("file_path") or args.get("filePath") or "assets/cursor-goal-red.png"
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    png = png_rgb(64, 64, 220, 40, 40)
    target.write_bytes(png)
    print(
        json.dumps(
            {
                "ok": True,
                "path": str(target),
                "bytes": len(png),
                "base64": base64.b64encode(png).decode(),
                "cursor": meta,
            }
        )
    )


if __name__ == "__main__":
    main()
