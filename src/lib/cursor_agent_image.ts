import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GenerateImageResult } from "./cursor_generate_image.ts";
import { normalizeGenerateImageArgs } from "./cursor_generate_image.ts";
import { parseArgs } from "./inference.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/cursor-agent-generate-image.py");

export async function generateImageViaAgentStream(opts: {
  description: string;
  filePath?: string;
  model?: string;
}): Promise<GenerateImageResult | null> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CURSOR_IMAGE_PATH: opts.filePath || "assets/cursor-agent-gen.png",
      CURSOR_IMAGE_MODEL: opts.model || "composer-2.5",
    };
    const child = spawn("python3", [SCRIPT, opts.description], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        resolve({
          status: "failed",
          conversationId: "",
          error: stderr.trim() || `python exit ${code}`,
        });
        return;
      }
      try {
        const j = JSON.parse(stdout.trim().split("\n").pop() || "{}") as Record<string, unknown>;
        if (j.error && j.status === "failed") {
          resolve({
            status: "failed",
            conversationId: String(j.conversationId || ""),
            error: String(j.error),
            credentialSource: "local_session",
          });
          return;
        }
        const tc = j.toolCall as Record<string, unknown> | undefined;
        if (j.status === "completed" && j.imageDataBase64) {
          resolve({
            status: "completed",
            conversationId: String(j.conversationId || ""),
            success: { imageDataBase64: String(j.imageDataBase64) },
            credentialSource: "local_session",
          });
          return;
        }
        if (tc) {
          resolve({
            status: "tool_call",
            conversationId: String(j.conversationId || ""),
            toolCall: {
              id: String(tc.id || ""),
              name: String(tc.name || "generate_image"),
              args: String(tc.args || "{}"),
              complete: true,
            },
            args: normalizeGenerateImageArgs(parseArgs(tc.args)),
            credentialSource: "local_session",
          });
          return;
        }
        resolve({
          status: "failed",
          conversationId: String(j.conversationId || ""),
          error: String(j.textSnippet || j.error || "agent stream returned no tool_call"),
          credentialSource: "local_session",
        });
      } catch (e) {
        resolve({
          status: "failed",
          conversationId: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  });
}
