#!/usr/bin/env python3
"""激进逆向：Inference tool_call → BidiAppend / 二轮 Chat → 扫描 PNG / imageData"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
import uuid
from pathlib import Path

DEMO = os.environ.get("CURSOR_AGENT_DEMO", "/tmp/cursor-api-demo-probe")
sys.path.insert(0, DEMO)

from cursor_agent_client import CursorAgentClient, ClientSideToolV2, ToolResult  # noqa: E402
from cursor_chat_proto import ToolCallDecoder  # noqa: E402


def cursor_version() -> str:
    for p in (
        "/Applications/Cursor.app/Contents/Resources/app/product.json",
        os.path.expanduser("~/Applications/Cursor.app/Contents/Resources/app/product.json"),
    ):
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f).get("version", "3.18.9")
    return "3.18.9"


def scan_image(raw: bytes) -> dict:
    out: dict = {}
    if re.search(rb"\x89PNG\r\n\x1a\n", raw):
        out["pngMagic"] = True
    m = re.search(rb'"imageData"\s*:\s*"([A-Za-z0-9+/=\r\n]{500,})"', raw)
    if not m:
        m = re.search(rb'"image_data"\s*:\s*"([A-Za-z0-9+/=\r\n]{500,})"', raw)
    if m:
        b64 = re.sub(rb"\s+", b"", m.group(1))
        out["imageDataBase64"] = b64[:200].decode() + "..."
        out["imageDataLen"] = len(b64)
        try:
            out["pngFromB64"] = base64.b64decode(b64[:200])[:8].hex()
        except Exception:
            pass
    return out


async def inference_tool_call(client: CursorAgentClient, auth, sid, ck, cs, prompt: str, model: str):
    """用 agent 编码 + grok 模型拉 generate_image tool_call"""
    orig = client.encode_agent_request

    def enc(messages, model_name, supported_tools=None):
        return orig(messages, model_name, supported_tools=[ClientSideToolV2.GENERATE_IMAGE])

    client.encode_agent_request = enc  # type: ignore
    import httpx

    url = f"{client.base_url}/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
    conv = str(uuid.uuid4())
    body = client.generate_request_body([{"role": "user", "content": prompt}], model)
    headers = client.get_headers(auth, sid, ck, cs)
    headers["x-conversation-id"] = conv
    raw = b""
    tc = None
    async with httpx.AsyncClient(http2=True, timeout=180.0) as http:
        async with http.stream("POST", url, headers=headers, content=body) as resp:
            if resp.status_code != 200:
                err = (await resp.aread())[:500]
                raise RuntimeError(f"chat stream {resp.status_code}: {err!r}")
            async for chunk in resp.aiter_bytes():
                raw += chunk
                t = client.parse_tool_call_from_chunk(chunk)
                if t and t.tool == ClientSideToolV2.GENERATE_IMAGE:
                    tc = t
    return conv, tc, raw


async def submit_tool_result(client, auth, sid, ck, cs, conv, tc: "ToolCall"):
    import httpx

    url = f"{client.base_url}/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
    headers = client.get_headers(auth, sid, ck, cs)
    headers["x-conversation-id"] = conv
    # 空成功结果，试探服务端是否接管生图
    tr = ToolResult(success=True, data={})
    inner = client.encode_tool_result_request(ClientSideToolV2.GENERATE_IMAGE, tc.tool_call_id, tr)
    body = client.frame_message(inner)
    raw = b""
    async with httpx.AsyncClient(http2=True, timeout=300.0) as http:
        async with http.stream("POST", url, headers=headers, content=body) as resp:
            async for chunk in resp.aiter_bytes():
                raw += chunk
    return raw


async def bidi_append(client, auth, sid, ck, cs, request_id: str, seqno: int, inner: bytes):
    import httpx

    url = f"{client.base_url}/aiserver.v1.BidiService/BidiAppend"
    headers = client.get_headers(auth, sid, ck, cs)
    headers["content-type"] = "application/proto"
    return await client.send_bidi_append(
        httpx.AsyncClient(http2=True, timeout=60.0),
        request_id,
        seqno,
        inner,
        headers,
        verbose=True,
    )


async def main() -> None:
    submit_only = os.environ.get("CURSOR_PIPELINE_SUBMIT_ONLY") == "1"
    prompt = " ".join(sys.argv[1:]) or "generate_image: solid red 32x32, file_path assets/cursor-rev.png"
    model = os.environ.get("CURSOR_IMAGE_MODEL", "grok-4.6")
    cwd = os.environ.get("CURSOR_WORKSPACE", os.getcwd())
    client = CursorAgentClient(workspace_root=cwd)
    ver = cursor_version()
    client.cursor_version = ver
    client.runtime.cursor_version = ver

    token = client.runtime.get_active_token() or client.token
    if not token:
        print(json.dumps({"status": "failed", "error": "no token"}))
        return
    auth = token.split("::")[-1]
    sid = client.generate_session_id(auth)
    ck = client.generate_hashed_64_hex(auth)
    cs = client.generate_cursor_checksum(auth)
    if not await client.runtime.establish_session(auth, sid, ck, cs):
        print(json.dumps({"status": "failed", "error": "preflight failed"}))
        return

    result = {"status": "failed", "clientVersion": ver, "model": model}
    try:
        if submit_only:
            from cursor_agent_client import ToolCall  # noqa: E402

            conv = os.environ["CURSOR_PIPELINE_CONV_ID"]
            tc = ToolCall(
                tool=ClientSideToolV2.GENERATE_IMAGE,
                tool_call_id=os.environ["CURSOR_PIPELINE_TOOL_ID"],
                name="generate_image",
                raw_args=os.environ.get("CURSOR_PIPELINE_TOOL_ARGS", "{}"),
                params=json.loads(os.environ.get("CURSOR_PIPELINE_TOOL_ARGS", "{}") or "{}"),
            )
            raw2 = await submit_tool_result(client, auth, sid, ck, cs, conv, tc)
            result["conversationId"] = conv
            result["turn2Bytes"] = len(raw2)
            result["turn2Scan"] = scan_image(raw2)
            if result["turn2Scan"].get("pngMagic") or result["turn2Scan"].get("imageDataLen"):
                result["status"] = "completed"
                if result["turn2Scan"].get("imageDataLen"):
                    result["imageDataBase64"] = result["turn2Scan"].get("imageDataBase64")
            else:
                result["status"] = "tool_call"
                result["note"] = "turn2 had no image; need Agent Run on api5 or IDE"
            print(json.dumps(result, ensure_ascii=False))
            return

        conv, tc, raw1 = await inference_tool_call(client, auth, sid, ck, cs, prompt, model)
        result["conversationId"] = conv
        result["turn1Bytes"] = len(raw1)
        result["turn1Scan"] = scan_image(raw1)
        if not tc:
            result["error"] = "no generate_image tool_call"
            print(json.dumps(result, ensure_ascii=False))
            return
        result["toolCall"] = {
            "id": tc.tool_call_id,
            "name": tc.name,
            "args": tc.raw_args or json.dumps(tc.params or {}),
        }
        raw2 = await submit_tool_result(client, auth, sid, ck, cs, conv, tc)
        result["turn2Bytes"] = len(raw2)
        result["turn2Scan"] = scan_image(raw2)
        result["turn2ToolCalls"] = ToolCallDecoder.find_tool_calls(raw2)
        if result["turn2Scan"].get("pngMagic") or result["turn2Scan"].get("imageDataLen"):
            result["status"] = "completed"
        else:
            result["status"] = "tool_call"
            result["note"] = "server did not return image bytes in turn2; needs Agent Run bidi or IDE"
    except Exception as e:
        result["error"] = str(e)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
