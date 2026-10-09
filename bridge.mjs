import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requestFrom,
  scopeFor,
  permissionArgs,
  inside,
  dayKey,
  idFor,
  newConversation,
  migrate,
  chunks,
  HELP,
  resultSchema,
  INSTRUCTIONS,
} from "./bridge-core.mjs";
import { run as runProcess } from "./bridge-process.mjs";
export class Bridge {
  constructor(root, config, { run = runProcess } = {}) {
    this.root = root;
    this.config = config;
    this.run = run;
    this.runtime = path.join(root, ".bridge");
    this.statePath = path.join(this.runtime, "state.json");
    this.saving = Promise.resolve();
    this.busy = false;
    this.flushing = false;
    this.shuttingDown = false;
  }
  log(text) {
    console.log(new Date().toISOString(), text);
  }
  async init() {
    await fs.mkdir(this.runtime, { recursive: true, mode: 0o700 });
    let old;
    try {
      old = JSON.parse(await fs.readFile(this.statePath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      old = { since: new Date().toISOString(), seen: [], jobs: [] };
    }
    this.state = migrate(old);
    this.state.version = 3;
    this.ownerScope = scopeFor(this.config.chatId, this.config.allowedUserId);
    this.state.chats ||= {};
    this.state.chats[this.config.chatId] ||= {
      userId: this.config.allowedUserId,
      since: this.state.since,
    };
    this.state.scopes ||= {};
    this.state.scopes[this.ownerScope] ||= {
      userId: this.config.allowedUserId,
      chatId: this.config.chatId,
      conversation: this.state.conversation,
    };
    if (
      this.state.conversation &&
      this.state.scopes[this.ownerScope].conversation?.threadId
    )
      this.state.scopes[this.ownerScope].conversation.directory ||= path.join(
        this.root,
        "output",
        "conversations",
        this.state.conversation.id,
      );
    if ((old.version || 1) < 3)
      this.state.scopes[this.ownerScope].conversation.legacy = this.state.jobs
        .filter((j) => j.image)
        .slice(-3)
        .map((j) => ({ path: j.image, prompt: j.prompt }));
    delete this.state.conversation;
    for (const j of this.state.jobs) {
      j.scope ||= this.ownerScope;
      j.chatId ||= this.config.chatId;
    }
    for (const x of this.state.outbox) {
      x.scope ||= this.ownerScope;
      x.chatId ||= this.config.chatId;
    }
    this.inbox = path.join(this.runtime, "inbox");
    await fs.mkdir(this.inbox, { recursive: true, mode: 0o700 });
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saving = this.saving.then(async () => {
      await fs.writeFile(this.statePath + ".tmp", snapshot, { mode: 0o600 });
      await fs.rename(this.statePath + ".tmp", this.statePath);
    });
    return this.saving;
  }
  async lark(args, options = {}) {
    const r = JSON.parse(
      await this.run(this.config.lark, args, { cwd: this.root, ...options }),
    );
    if (r.ok === false) throw new Error(r.error?.message || "飞书接口失败");
    return r;
  }
  async reply(key, text, { messageId, jobId, scope = this.ownerScope } = {}) {
    chunks(text).forEach((text, i) => {
      const id = key + "-" + i;
      if (!this.state.outbox.some((x) => x.id === id))
        this.state.outbox.push({
          id,
          kind: "text",
          text,
          messageId,
          jobId,
          scope,
          chatId: this.state.scopes[scope].chatId,
          status: "pending",
          attempts: 0,
        });
    });
    await this.save();
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const item of this.state.outbox.filter(
        (x) => x.status === "pending",
      )) {
        if (this.shuttingDown) break;
        if (item.nextAttempt > Date.now()) continue;
        const args = [
          "im",
          item.messageId ? "+messages-reply" : "+messages-send",
          "--as",
          "bot",
          item.messageId ? "--message-id" : "--chat-id",
          item.messageId || item.chatId,
        ];
        args.push(
          item.kind === "text"
            ? "--text"
            : item.kind === "image"
              ? "--image"
              : "--file",
          item.kind === "text"
            ? item.text
            : path.relative(this.root, item.path),
          "--idempotency-key",
          item.id,
        );
        try {
          const r = await this.lark(args);
          item.status = "sent";
          item.sentId = r.data?.message_id;
          delete item.error;
          const job = this.state.jobs.find((j) => j.id === item.jobId);
          if (
            job?.status === "answer_ready" &&
            !this.state.outbox.some(
              (x) => x.jobId === job.id && x.status === "pending",
            )
          )
            job.status = "done";
          await this.save();
        } catch (e) {
          item.attempts++;
          item.error = e.message;
          item.nextAttempt =
            Date.now() +
            Math.min(300000, 5000 * 2 ** Math.min(item.attempts, 6));
          await this.save();
          this.log(
            "delivery pending " + item.id + ": " + e.message.slice(0, 120),
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
  async accept(message) {
    if (!message.message_id || this.state.seen.includes(message.message_id))
      return;
    const chat = this.state.chats[message.chat_id];
    if (!chat) return;
    const scope = scopeFor(message.chat_id, chat.userId);
    const request = requestFrom(message, {
        ...this.config,
        chatId: message.chat_id,
        allowedUserId: chat.userId,
      }),
      id = idFor(message.message_id);
    this.state.seen.push(message.message_id);
    if (!request) {
      await this.save();
      return;
    }
    const reply = (text) =>
      this.reply(id + "-control", text, {
        messageId: message.message_id,
        scope,
      });
    if (request.kind === "help") return reply(HELP);
    if (request.kind === "status") {
      const names = {
        queued: "排队中",
        running: "处理中",
        answer_ready: "等待回传",
        done: "已完成",
        failed: "失败",
        interrupted: "中断",
        cancelled: "已取消",
      };
      return reply(
        "最近任务：\n" +
          (this.state.jobs
            .filter((j) => j.scope === scope)
            .slice(-5)
            .map((j) => `${j.id}：${names[j.status] || j.status}`)
            .join("\n") || "暂无") +
          `\n待回传：${this.state.outbox.filter((x) => x.scope === scope && x.status === "pending").length} 条`,
      );
    }
    if (request.kind === "cancel") {
      for (const j of this.state.jobs)
        if (j.scope === scope && j.status === "queued") j.status = "cancelled";
      if (this.activeScope === scope) this.controller?.abort();
      return reply("已取消排队任务，并通知当前任务停止。已发出的内容会保留。");
    }
    if (request.kind === "invalid")
      return reply("这条消息太长，请控制在 12000 字以内，或上传文件。");
    if (request.kind === "unsupported")
      return reply(
        "目前支持文字、图片和常见文件。语音或视频请先转换为文字、截图或文件。",
      );
    let r = request;
    if (r.kind === "retry") {
      const previous = [...this.state.jobs]
        .reverse()
        .find(
          (j) =>
            j.scope === scope && ["failed", "interrupted"].includes(j.status),
        );
      if (!previous)
        return reply(
          "没有可重试的失败任务。回传失败会自动重发，不会重新生成。",
        );
      r = {
        kind: "chat",
        prompt: previous.prompt,
        attachments: previous.attachments || [],
        attachmentMessageId: previous.attachmentMessageId || previous.sourceId,
      };
    }
    if (
      this.state.jobs.filter(
        (j) => j.scope === scope && ["queued", "running"].includes(j.status),
      ).length >= this.config.maxQueue
    )
      return reply("当前队列已满，请稍后发送，或发“停止”取消。");
    if (
      r.kind !== "reset" &&
      this.state.jobs.filter(
        (j) => j.scope === scope && j.day === dayKey() && j.kind === "chat",
      ).length >= this.config.dailyLimit
    )
      return reply(`今天已达到 ${this.config.dailyLimit} 条任务上限。`);
    this.state.jobs.push({
      id,
      scope,
      chatId: message.chat_id,
      kind: r.kind === "reset" ? "reset" : "chat",
      prompt: r.prompt || "",
      attachments: r.attachments || [],
      sourceId: message.message_id,
      attachmentMessageId: r.attachmentMessageId || message.message_id,
      status: "queued",
      day: dayKey(),
      createdAt: new Date().toISOString(),
    });
    await this.save();
    const queued = this.state.jobs.filter(
      (j) => j.scope === scope && j.status === "queued",
    ).length;
    if (this.busy || queued > 1)
      await reply(`收到，已进入你的任务队列。服务器会依次处理。`);
  }
  async ingestEvent(event) {
    if (
      event.type !== "im.message.receive_v1" ||
      event.chat_type !== "p2p" ||
      event.sender_type !== "user"
    )
      return;
    if (
      !/^oc_[\w-]+$/.test(event.chat_id || "") ||
      !/^ou_[\w-]+$/.test(event.sender_id || "")
    )
      return;
    if (!this.config.teamMode && event.sender_id !== this.config.allowedUserId)
      return;
    const known = this.state.chats[event.chat_id];
    if (known && known.userId !== event.sender_id)
      throw new Error("私聊绑定不一致，拒绝事件");
    const scope = scopeFor(event.chat_id, event.sender_id);
    const created = Number(event.create_time);
    this.state.chats[event.chat_id] ||= {
      userId: event.sender_id,
      since: new Date(
        Number.isFinite(created) && created > 0
          ? created - 30000
          : Date.now() - 30000,
      ).toISOString(),
    };
    this.state.scopes[scope] ||= {
      userId: event.sender_id,
      chatId: event.chat_id,
      conversation: newConversation(),
    };
    await this.accept({
      message_id: event.message_id || event.id,
      chat_id: event.chat_id,
      sender: { id: event.sender_id, sender_type: "user" },
      msg_type: event.message_type,
      content: event.content,
    });
  }
  async drainInbox() {
    const events = [];
    for (const name of (await fs.readdir(this.inbox)).filter((n) =>
      n.endsWith(".json"),
    )) {
      const file = path.join(this.inbox, name);
      try {
        events.push({
          file,
          event: JSON.parse(await fs.readFile(file, "utf8")),
        });
      } catch {}
    }
    events.sort(
      (a, b) =>
        Number(a.event.create_time || 0) - Number(b.event.create_time || 0),
    );
    for (const { file, event } of events) {
      await this.ingestEvent(event);
      await this.save();
      await fs.unlink(file);
    }
  }

  async poll() {
    const errors = [];
    for (const chatId of Object.keys(this.state.chats)) {
      try {
        await this.pollChat(chatId);
      } catch (e) {
        errors.push(e);
        this.log("poll chat error: " + e.message);
      }
    }
    if (errors.length) throw errors[0];
  }
  async pollChat(chatId) {
    const end = new Date(Date.now() - 1500).toISOString(),
      start = this.state.chats[chatId].since;
    let token,
      pages = 0;
    do {
      const args = [
        "im",
        "+chat-messages-list",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--start",
        start,
        "--end",
        end,
        "--order",
        "asc",
        "--page-size",
        "50",
        "--no-reactions",
      ];
      if (token) args.push("--page-token", token);
      const r = await this.lark(args);
      for (const m of r.data?.messages || []) await this.accept(m);
      token = r.data?.has_more ? r.data.page_token : null;
      if (r.data?.has_more && !token) throw new Error("消息分页缺少游标");
      if (++pages >= 100 && token)
        throw new Error("历史消息超过分页上限，保留原游标");
    } while (token && !this.shuttingDown);
    if (!this.shuttingDown) {
      this.state.chats[chatId].since = new Date(
        Date.parse(end) - 30000,
      ).toISOString();
      if (chatId === this.config.chatId)
        this.state.since = this.state.chats[chatId].since;
      this.state.lastPollAt = new Date().toISOString();
      await this.save();
    }
  }
  async download(job, folder) {
    const files = [];
    for (const [index, resource] of (job.attachments || []).entries()) {
      const dir = path.join(folder, "input-" + index);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const r = await this.lark(
        [
          "im",
          "+messages-resources-download",
          "--as",
          "bot",
          "--message-id",
          job.attachmentMessageId || job.sourceId,
          "--file-key",
          resource.key,
          "--type",
          resource.type,
        ],
        { cwd: dir, signal: this.controller.signal },
      );
      const file = await fs.realpath(r.data.saved_path);
      if (!inside(await fs.realpath(dir), file))
        throw new Error("附件路径越界");
      if ((await fs.stat(file)).size > 20 * 1024 * 1024)
        throw new Error("附件超过 20MB");
      if (
        resource.type === "file" &&
        ![
          ".txt",
          ".md",
          ".csv",
          ".tsv",
          ".json",
          ".pdf",
          ".docx",
          ".xlsx",
          ".pptx",
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
        ].includes(path.extname(file).toLowerCase())
      )
        throw new Error("附件类型不支持");
      files.push({
        path: file,
        kind: resource.type === "image" ? "image" : "file",
      });
    }
    return files;
  }
  async validateArtifacts(artifacts, folder) {
    if (!Array.isArray(artifacts) || artifacts.length > 5)
      throw new Error("交付文件列表无效");
    const root = await fs.realpath(folder),
      valid = [];
    for (const a of artifacts) {
      const file = await fs.realpath(a.path);
      if (!inside(root, file)) throw new Error("交付文件路径越界");
      const s = await fs.stat(file);
      if (!s.isFile() || s.size > 20 * 1024 * 1024)
        throw new Error("交付文件过大或不是普通文件");
      if (
        ![
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
          ".pdf",
          ".txt",
          ".md",
          ".csv",
          ".tsv",
          ".json",
          ".xlsx",
          ".docx",
          ".pptx",
        ].includes(path.extname(file).toLowerCase())
      )
        throw new Error("交付文件类型不支持");
      if (a.kind === "image") {
        const b = await fs.readFile(file);
        if (!(
          b
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (b[0] === 255 && b[1] === 216 && b[2] === 255) ||
          (b.toString("ascii", 0, 4) === "RIFF" &&
            b.toString("ascii", 8, 12) === "WEBP")
        ))
          throw new Error("图片格式校验失败");
      }
      valid.push({ path: file, kind: a.kind === "image" ? "image" : "file" });
    }
    return valid;
  }
  async work() {
    if (this.busy || this.shuttingDown) return;
    const job = this.state.jobs.find((j) => j.status === "queued");
    if (!job) return;
    this.busy = true;
    this.activeScope = job.scope;
    this.controller = new AbortController();
    let heartbeat;
    try {
      job.status = "running";
      await this.save();
      if (job.kind === "reset") {
        this.state.scopes[job.scope].conversation = newConversation();
        job.status = "answer_ready";
        await this.reply(
          job.id + "-answer",
          "已开启新对话。旧的图片和文件仍保留。",
          { messageId: job.sourceId, jobId: job.id, scope: job.scope },
        );
        return;
      }
      const conversation = this.state.scopes[job.scope].conversation,
        directory =
          conversation.directory ||
          path.join(
            this.root,
            "output",
            "employees",
            job.scope,
            conversation.id,
          ),
        turn = path.join(directory, "turns", job.id),
        artifactsDir = path.join(turn, "artifacts");
      await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
      conversation.directory = directory;
      job.directory = turn;
      for (const [i, old] of (conversation.legacy || []).entries()) {
        if (inside(directory, old.path)) continue;
        const dest = path.join(
          directory,
          "legacy",
          "image-" + i + path.extname(old.path),
        );
        await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await fs.copyFile(old.path, dest);
        old.path = dest;
      }
      await fs.writeFile(path.join(turn, "request.txt"), job.prompt, {
        mode: 0o600,
      });
      await fs.writeFile(
        path.join(turn, "schema.json"),
        JSON.stringify(resultSchema),
      );
      const attachments = await this.download(job, turn);
      conversation.attachments.push(...attachments);
      conversation.attachments = conversation.attachments.slice(-12);
      const legacy = conversation.legacy || [];
      const prompt = `用户消息：\n${job.prompt}\n\n本轮附件：${JSON.stringify(attachments)}\n近期参考文件：${JSON.stringify(conversation.attachments)}\n${conversation.threadId ? "" : `升级前的历史素材（仅在用户指代时使用）：${JSON.stringify(legacy)}\n`}本轮交付文件目录：${artifactsDir}\n按 schema 返回，answer 为直接给用户的回复。`;
      const args = [
        "exec",
        "--skip-git-repo-check",
        ...permissionArgs(directory),
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "computer_use",
        "--disable",
        "browser_use",
        "-c",
        'web_search="live"',
        "-c",
        "developer_instructions=" + JSON.stringify(INSTRUCTIONS),
        "--json",
        "--output-schema",
        path.join(turn, "schema.json"),
        "-o",
        path.join(turn, "result.json"),
      ];
      if (this.config.model) args.push("--model", this.config.model);
      if (this.config.reasoningEffort)
        args.push(
          "-c",
          "model_reasoning_effort=" +
            JSON.stringify(this.config.reasoningEffort),
        );
      if (conversation.threadId) args.push("resume", conversation.threadId);
      for (const a of attachments.filter((a) => a.kind === "image"))
        args.push("-i", a.path);
      args.push("-");
      let beat = 0;
      heartbeat = setInterval(() => {
        if (++beat <= 3)
          this.reply(
            job.id + "-progress" + beat,
            beat === 1
              ? "我正在处理，完成后会在这里回复。"
              : "任务仍在处理中，可以继续发补充信息排队，或发“停止”取消。",
            { messageId: job.sourceId, scope: job.scope },
          ).catch((e) => this.log(e.message));
      }, 60000);
      await this.run(this.config.codex, args, {
        cwd: directory,
        input: prompt,
        timeout: this.config.taskTimeoutMs || 900000,
        logFile: path.join(turn, "events.jsonl"),
        signal: this.controller.signal,
        onEvent: (e) => {
          if (e.type === "thread.started" && e.thread_id) {
            conversation.threadId = e.thread_id;
            job.threadId = e.thread_id;
            this.save().catch((e) => this.log(e.message));
          }
        },
      });
      clearInterval(heartbeat);
      if (this.controller.signal.aborted) throw new Error("任务已取消");
      const result = JSON.parse(
        await fs.readFile(path.join(turn, "result.json"), "utf8"),
      );
      if (typeof result.answer !== "string") throw new Error("回复格式错误");
      const imported = [];
      const generatedRoot = job.threadId
        ? path.join(
            process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"),
            "generated_images",
            job.threadId,
          )
        : null;
      for (const [i, a] of result.artifacts.entries()) {
        let file = await fs.realpath(a.path);
        if (
          a.kind === "image" &&
          !inside(await fs.realpath(artifactsDir), file) &&
          generatedRoot
        ) {
          const allowed = await fs.realpath(generatedRoot).catch(() => null);
          if (!allowed || !inside(allowed, file))
            throw new Error("生成图片不属于当前会话");
          const destination = path.join(
            artifactsDir,
            "generated-" + i + path.extname(file),
          );
          await fs.copyFile(file, destination);
          file = destination;
        }
        imported.push({ ...a, path: file });
      }
      const artifacts = await this.validateArtifacts(imported, artifactsDir);
      job.answer = result.answer;
      job.artifacts = artifacts;
      job.status = "answer_ready";
      conversation.attachments.push(...artifacts);
      conversation.attachments = conversation.attachments.slice(-12);
      chunks(result.answer || "已完成。").forEach((text, i) =>
        this.state.outbox.push({
          id: job.id + "-answer-" + i,
          kind: "text",
          text,
          messageId: job.sourceId,
          jobId: job.id,
          scope: job.scope,
          chatId: job.chatId,
          status: "pending",
          attempts: 0,
        }),
      );
      artifacts.forEach((a, i) =>
        this.state.outbox.push({
          id: job.id + "-artifact-" + i,
          ...a,
          messageId: job.sourceId,
          jobId: job.id,
          scope: job.scope,
          chatId: job.chatId,
          status: "pending",
          attempts: 0,
        }),
      );
      await this.save();
      this.log("answer ready " + job.id);
    } catch (e) {
      job.status = this.shuttingDown
        ? "interrupted"
        : this.controller.signal.aborted
          ? "cancelled"
          : "failed";
      job.error = e.message;
      await this.save();
      if (job.directory)
        await fs
          .writeFile(path.join(job.directory, "error.txt"), e.message, {
            mode: 0o600,
          })
          .catch(() => {});
      if (!this.shuttingDown)
        await this.reply(
          job.id + "-error",
          job.status === "cancelled"
            ? "当前任务已停止。"
            : "这次处理未完成。可以发“重试”，或换一种描述。已保存的文件会保留。",
          { messageId: job.sourceId, scope: job.scope },
        );
      this.log(`job ${job.status} ${job.id}: ${e.message.slice(0, 180)}`);
    } finally {
      clearInterval(heartbeat);
      this.controller = null;
      this.activeScope = null;
      this.busy = false;
    }
  }
}
async function main() {
  const root = path.dirname(fileURLToPath(import.meta.url)),
    config = JSON.parse(
      await fs.readFile(path.join(root, "bridge.config.json"), "utf8"),
    ),
    runtime = path.join(root, ".bridge");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const lock = path.join(runtime, "service-v2.pid");
  try {
    const old = Number(await fs.readFile(lock, "utf8"));
    if (old > 0) {
      try {
        process.kill(old, 0);
        throw new Error("助手已运行");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.writeFile(lock, String(process.pid), { mode: 0o600 });
  const bridge = new Bridge(root, config);
  await bridge.init();
  const stop = () => {
    bridge.shuttingDown = true;
    bridge.controller?.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  bridge.log("employee bridge v3 started");
  const eventController = new AbortController();
  const eventLoop = (async () => {
    while (!bridge.shuttingDown) {
      try {
        await runProcess(
          config.lark,
          [
            "event",
            "consume",
            "im.message.receive_v1",
            "--as",
            "bot",
            "--timeout",
            "24h",
            "--output-dir",
            path.relative(root, bridge.inbox),
          ],
          {
            cwd: root,
            timeout: 0,
            signal: eventController.signal,
            logFile: path.join(runtime, "events.ndjson"),
            onStderr: (line) => {
              if (line.includes("[event] ready"))
                bridge.log("event receiver ready");
              else if (/error|drop|fail/i.test(line))
                bridge.log("event diagnostic: " + line.trim().slice(0, 300));
            },
          },
        );
      } catch (e) {
        if (!bridge.shuttingDown)
          bridge.log("event error: " + e.message.slice(0, 160));
      }
      if (!bridge.shuttingDown) await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  let lastPoll = 0,
    worker = Promise.resolve();
  while (!bridge.shuttingDown) {
    await bridge.drainInbox();
    if (Date.now() - lastPoll >= config.pollSeconds * 1000) {
      lastPoll = Date.now();
      try {
        await bridge.poll();
      } catch (e) {
        bridge.log("poll error: " + e.message.slice(0, 180));
      }
    }
    if (!bridge.busy)
      worker = bridge
        .work()
        .catch((e) => bridge.log("worker error: " + e.message));
    await bridge.flush();
    await new Promise((r) => setTimeout(r, 1000));
  }
  eventController.abort();
  await eventLoop;
  await worker;
  await bridge.save();
  await fs.unlink(lock).catch(() => {});
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
