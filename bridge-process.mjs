import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
export function run(
  binary,
  args,
  { cwd, input = "", timeout = 60000, logFile, signal, onEvent, onStderr } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消"));
    const child = spawn(binary, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "",
      stderr = "",
      lines = "",
      stopped = "";
    const stream = logFile ? createWriteStream(logFile, { mode: 0o600 }) : null;
    const kill = (sig) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch (e) {
        if (e.code !== "ESRCH") child.kill(sig);
      }
    };
    const stop = (reason) => {
      stopped = reason;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 3000).unref();
    };
    const abort = () => stop("任务已取消");
    signal?.addEventListener("abort", abort, { once: true });
    const timer =
      timeout > 0 ? setTimeout(() => stop("任务超时"), timeout) : null;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (chunk) => {
      if (stream) stream.write(chunk);
      else stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) stop("接口返回内容过大");
      if (onEvent) {
        lines += chunk;
        let pos;
        while ((pos = lines.indexOf("\n")) >= 0) {
          const line = lines.slice(0, pos);
          lines = lines.slice(pos + 1);
          try {
            onEvent(JSON.parse(line));
          } catch {}
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
      onStderr?.(chunk.toString());
    });
    child.on("error", (e) => {
      cleanup();
      stream?.end();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      const finish = () =>
        code === 0 && !stopped
          ? resolve(stdout)
          : reject(
              new Error(stopped || `进程退出 ${code}: ${stderr.slice(-1800)}`),
            );
      if (stream) stream.end(finish);
      else finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
