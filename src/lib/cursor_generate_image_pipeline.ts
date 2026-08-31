import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GenerateImageResult, GenerateImageOptions } from "./cursor_generate_image.ts";
import {
  normalizeGenerateImageArgs,
  requestGenerateImageToolCall,
} from "./cursor_generate_image.ts";
import { resolveCursorAccessToken } from "./cursor_credentials.ts";
import { parseArgs } from "./inference.ts";
import { scanStreamForImage } from "./cursor_proto_scan.ts";

const PIPELINE = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/cursor-generate-image-pipeline.py");

/** TS 拿 tool_call + Python 提交 tool result 并扫描二轮流 */
export async function generateImagePipeline(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const args = normalizeGenerateImageArgs({
    description: opts.description,
    file_path: opts.filePath,
    reference_image_paths: opts.referenceImagePaths,
  });
  const { accessToken, source } = await resolveCursorAccessToken({
    apiKey: opts.apiKey,
    preferApiKey: opts.preferApiKey,
  });
  const { conversationId, toolCall } = await requestGenerateImageToolCall(accessToken, args, {
    model: opts.model,
  });

  const pyResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const env = {
      ...process.env,
      CURSOR_PIPELINE_TOOL_ID: toolCall.id,
      CURSOR_PIPELINE_TOOL_ARGS: toolCall.args,
      CURSOR_PIPELINE_CONV_ID: conversationId,
      CURSOR_IMAGE_MODEL: opts.model || "grok-4.6",
      CURSOR_PIPELINE_SUBMIT_ONLY: "1",
    };
    const child = spawn("python3", [PIPELINE, args.description], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => {
      if (!out.trim()) {
        reject(new Error(err || `pipeline exit ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });

  const base: GenerateImageResult = {
    status: "tool_call",
    conversationId,
    toolCall,
    args: normalizeGenerateImageArgs(parseArgs(toolCall.args)),
    credentialSource: source,
  };

  const scan = (pyResult.turn2Scan || pyResult.turn1Scan) as Record<string, unknown> | undefined;
  const b64 =
    typeof pyResult.imageDataBase64 === "string"
      ? pyResult.imageDataBase64
      : typeof scan?.imageDataBase64 === "string"
        ? scan.imageDataBase64
        : undefined;

  if (pyResult.status === "completed" || scan?.pngMagic || b64) {
    return {
      ...base,
      status: "completed",
      success: b64
        ? { imageDataBase64: b64.replace(/\.\.\.$/, "") }
        : { filePath: args.filePath },
    };
  }

  return { ...base, error: String(pyResult.error || pyResult.note || "") || undefined };
}
