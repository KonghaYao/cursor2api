/**
 * agent.api5.cursor.sh 上的 agent.v1.AgentService（与 api2 Inference 不同）
 */
import { encodeConnectFrame, decodeConnectFrames, bytesBody } from "./bytes.ts";
import { buildIdeClientContext, ideConnectHeaders } from "./cursor_ide_client.ts";

export const AGENT_API_HOSTS = [
  "https://agent.api5.cursor.sh",
  "https://agentn.api5.cursor.sh",
  "https://api2.cursor.sh",
] as const;

export async function probeAgentRunHeartbeat(
  accessToken: string,
  host: string,
): Promise<{ status: number; frames: number; sample?: string }> {
  const ctx = buildIdeClientContext(accessToken);
  const payload = encodeConnectFrame({}); // 试探空 client message
  const res = await fetch(`${host}/agent.v1.AgentService/Run`, {
    method: "POST",
    headers: {
      ...ideConnectHeaders(ctx),
      "content-type": "application/connect+json",
      "connect-accept-encoding": "gzip",
    },
    body: bytesBody(payload),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const frames = await decodeConnectFrames(buf);
  const sample = frames
    .map((f) => JSON.stringify(f.json))
    .join("")
    .slice(0, 400);
  return { status: res.status, frames: frames.length, sample };
}
