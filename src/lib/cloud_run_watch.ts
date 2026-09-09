/**
 * Keep one Cloud Agents SSE reader alive (models/legacy REST helpers).
 * Chat does not use this path; it goes through AgentService/Run customTools.
 */
import { collectCloudRunResult, iterateSse, streamCloudRun } from "./cloud_agents.ts";

export type CloudRunWatch = {
  agentId: string;
  runId: string;
  text: string;
  thinking: string;
  status: string;
  error?: string;
  done: boolean;
  waitFinished: () => Promise<void>;
  abort: () => void;
};

export function startCloudRunWatch(opts: {
  apiKey: string;
  agentId: string;
  runId: string;
  signal?: AbortSignal;
}): CloudRunWatch {
  const { apiKey, agentId, runId, signal } = opts;
  let text = "";
  let thinking = "";
  let status = "RUNNING";
  let error: string | undefined;
  let done = false;
  let notifyFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    notifyFinished = resolve;
  });
  const textWaiters = new Set<(chunk: { text?: string; thinking?: string }) => void>();
  const abort = new AbortController();
  if (signal) {
    if (signal.aborted) abort.abort(signal.reason);
    else signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
  }

  const finish = () => {
    if (done) return;
    done = true;
    notifyFinished();
  };

  const pump = async () => {
    try {
      const res = await streamCloudRun(apiKey, agentId, runId, abort.signal);
      for await (const ev of iterateSse(res)) {
        if (ev.event === "assistant" && ev.data.text) {
          const chunk = String(ev.data.text);
          text += chunk;
          for (const fn of textWaiters) fn({ text: chunk });
        }
        if (ev.event === "thinking" && ev.data.text) {
          const chunk = String(ev.data.text);
          thinking += chunk;
          for (const fn of textWaiters) fn({ thinking: chunk });
        }
        if (ev.event === "status") status = String(ev.data.status || status);
        if (ev.event === "result") {
          status = String(ev.data.status || status);
          if (ev.data.text != null) text = String(ev.data.text);
          if (ev.data.error != null) error = String(ev.data.error);
        }
        if (ev.event === "error") error = String(ev.data.message || ev.data.code || "cloud run error");
        if (ev.event === "done") break;
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        try {
          const fallback = await collectCloudRunResult(apiKey, agentId, runId);
          text = fallback.text || text;
          status = fallback.status || status;
          error = fallback.error || error;
        } catch {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      finish();
    }
  };

  void pump();

  const watch: CloudRunWatch & {
    onDelta?: (fn: (chunk: { text?: string; thinking?: string }) => void) => () => void;
  } = {
    get agentId() {
      return agentId;
    },
    get runId() {
      return runId;
    },
    get text() {
      return text;
    },
    get thinking() {
      return thinking;
    },
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get done() {
      return done;
    },
    waitFinished: () => finished,
    abort: () => {
      abort.abort();
      finish();
    },
  };
  (watch as { onDelta: (fn: (chunk: { text?: string; thinking?: string }) => void) => () => void }).onDelta = (fn) => {
    if (text) fn({ text });
    if (thinking) fn({ thinking });
    textWaiters.add(fn);
    return () => {
      textWaiters.delete(fn);
    };
  };
  return watch;
}

export function watchOnDelta(
  watch: CloudRunWatch,
  fn: (chunk: { text?: string; thinking?: string }) => void,
): () => void {
  const extra = watch as CloudRunWatch & { onDelta?: (fn: (chunk: { text?: string; thinking?: string }) => void) => () => void };
  return extra.onDelta ? extra.onDelta(fn) : () => undefined;
}
