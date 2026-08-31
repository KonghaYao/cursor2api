#!/usr/bin/env python3
"""
Cursor Agent 生图探测（StreamUnifiedChatWithTools + IDE 头）

依赖：
  pip install httpx 'httpx[http2]' h2
  export CURSOR_AGENT_DEMO=/path/to/eisbaw/cursor_api_demo  # 含 cursor_agent_client.py

stdout：单行 JSON
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import uuid
from pathlib import Path


def _demo_path() -> str:
    p = os.environ.get("CURSOR_AGENT_DEMO", "").strip()
    if p and os.path.isdir(p):
        return p
    for cand in (
        "/tmp/cursor-api-demo-probe",
        str(Path(__file__).resolve().parents[1] / "third_party" / "cursor_api_demo"),
    ):
        if os.path.isfile(os.path.join(cand, "cursor_agent_client.py")):
            return cand
    return ""


def _cursor_version() -> str:
    for p in (
        "/Applications/Cursor.app/Contents/Resources/app/product.json",
        os.path.expanduser("~/Applications/Cursor.app/Contents/Resources/app/product.json"),
    ):
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f).get("version") or "3.18.9"
            except Exception:
                pass
    return os.environ.get("CURSOR_CLIENT_VERSION", "3.18.9")


async def run(description: str, file_path: str, model: str) -> dict:
    demo = _demo_path()
    if not demo:
        return {
            "status": "failed",
            "error": "CURSOR_AGENT_DEMO not set (eisbaw/cursor_api_demo)",
        }
    sys.path.insert(0, demo)
    from cursor_agent_client import CursorAgentClient, ClientSideToolV2  # type: ignore

    root = os.getcwd()
    client = CursorAgentClient(workspace_root=root)
    ver = _cursor_version()
    client.cursor_version = ver
    client.runtime.cursor_version = ver

    orig = client.encode_agent_request

    def enc(messages, model_name, supported_tools=None):
        tools = list(client.DEFAULT_TOOLS) + [ClientSideToolV2.GENERATE_IMAGE]
        return orig(messages, model_name, supported_tools=tools)

    client.encode_agent_request = enc  # type: ignore

    token = client.runtime.get_active_token() or client.token
    if not token:
        return {"status": "failed", "error": "no cursor access token in state.vscdb"}
    auth = token.split("::")[-1]
    sid = client.generate_session_id(auth)
    ck = client.generate_hashed_64_hex(auth)
    cs = client.generate_cursor_checksum(auth)
    ok = await client.runtime.establish_session(auth, sid, ck, cs)
    if not ok:
        return {"status": "failed", "error": "AvailableModels preflight failed"}

    import httpx

    url = f"{client.base_url}/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
    conv = str(uuid.uuid4())
    prompt = (
        f"Use generate_image only. description={description!r}, file_path={file_path!r}. "
        "Do not use other tools."
    )
    messages = [{"role": "user", "content": prompt}]
    body = client.generate_request_body(messages, model)
    headers = client.get_headers(auth, sid, ck, cs)
    headers["x-conversation-id"] = conv

    raw = b""
    status = 0
    async with httpx.AsyncClient(http2=True, timeout=180.0) as http:
        async with http.stream("POST", url, headers=headers, content=body) as resp:
            status = resp.status_code
            if status != 200:
                err = (await resp.aread())[:800].decode("utf-8", "ignore")
                return {"status": "failed", "error": err, "httpStatus": status}
            async for chunk in resp.aiter_bytes():
                raw += chunk

    text = raw.decode("utf-8", errors="ignore")
    tool = client.parse_tool_call_from_chunk(raw)
    png = bool(re.search(rb"iVBORw0KGgo", raw))
    b64m = re.search(rb'"imageData"\s*:\s*"([A-Za-z0-9+/=]{200,})"', raw) or re.search(
        rb'"image_data"\s*:\s*"([A-Za-z0-9+/=]{200,})"', raw
    )

    out = {
        "status": "tool_call" if tool else "text_only",
        "conversationId": conv,
        "clientVersion": ver,
        "httpStatus": status,
        "bytes": len(raw),
        "textSnippet": text[:2000],
        "credentialSource": "local_session",
    }
    if tool:
        out["toolCall"] = {
            "id": tool.tool_call_id,
            "name": tool.name,
            "args": tool.raw_args or json.dumps(tool.params or {}),
        }
    if png or b64m:
        out["status"] = "completed"
        if b64m:
            out["imageDataBase64"] = b64m.group(1).decode("ascii")
    if b"resource_exhausted" in raw or b'"error"' in raw[:120]:
        if out["status"] != "completed":
            out["status"] = "failed"
            out["error"] = text[:500]
    return out


def main() -> None:
    description = " ".join(sys.argv[1:]) or "a small red circle icon"
    file_path = os.environ.get("CURSOR_IMAGE_PATH", "assets/cursor-agent-gen.png")
    model = os.environ.get("CURSOR_IMAGE_MODEL", "composer-2.5")
    result = asyncio.run(run(description, file_path, model))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
