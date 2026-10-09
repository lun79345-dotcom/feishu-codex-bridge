import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestFrom, inside, chunks, migrate, idFor } from "./bridge-core.mjs";
import { Bridge } from "./bridge.mjs";
import { run } from "./bridge-process.mjs";
const config = {
  chatId: "private",
  allowedUserId: "owner",
  lark: "lark",
  codex: "codex",
  maxQueue: 10,
  dailyLimit: 200,
};
const msg = (id = "om_test", content = "你好") => ({
  message_id: id,
  chat_id: "private",
  sender: { id: "owner", sender_type: "user" },
  msg_type: "text",
  content,
});
async function setup(
  t,
  runner = async () =>
    JSON.stringify({ ok: true, data: { message_id: "sent" } }),
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-bridge-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const b = new Bridge(dir, config, { run: runner });
  await b.init();
  return b;
}
test("only owner private messages accepted; ordinary language is a chat", () => {
  assert.equal(
    requestFrom(
      { ...msg(), sender: { id: "other", sender_type: "user" } },
      config,
    ),
    null,
  );
  assert.equal(
    requestFrom(
      { ...msg(), sender: { id: "owner", sender_type: "app" } },
      config,
    ),
    null,
  );
  assert.equal(requestFrom({ ...msg(), chat_id: "group" }, config), null);
  assert.equal(requestFrom({ ...msg(), deleted: true }, config), null);
  assert.equal(requestFrom(msg(), config).kind, "chat");
  assert.equal(requestFrom(msg("1", "/新对话"), config).kind, "reset");
  assert.equal(requestFrom(msg("1", "解释一下“新对话”"), config).kind, "chat");
});
test("image resources and JSON text parse correctly", () => {
  assert.equal(
    requestFrom(msg("1", JSON.stringify({ text: "写个脚本" })), config).prompt,
    "写个脚本",
  );
  assert.deepEqual(
    requestFrom(
      { ...msg(), msg_type: "image", content: "[Image: img_v3_ab-123]" },
      config,
    ).attachments,
    [{ key: "img_v3_ab-123", type: "image" }],
  );
});
test("Unicode splitting preserves full content", () => {
  const s = "中文😀".repeat(3000);
  assert.equal(chunks(s).join(""), s);
  assert.ok(chunks(s).every((p) => Array.from(p).length <= 1800));
});
test("migration preserves cursor and marks interrupted jobs without rerun", () => {
  const s = migrate({
    since: "old",
    jobs: [
      { id: "1", status: "running" },
      { id: "2", status: "queued" },
    ],
  });
  assert.equal(s.since, "old");
  assert.equal(s.jobs[0].status, "interrupted");
  assert.equal(s.jobs[1].status, "queued");
});
test("duplicate events remain deduplicated after restart", async (t) => {
  const b = await setup(t);
  await b.accept(msg());
  await b.accept(msg());
  const restart = new Bridge(b.root, config, { run: b.run });
  await restart.init();
  await restart.accept(msg());
  assert.equal(restart.state.jobs.length, 1);
});
test("delivery retries use same id and never regenerate", async (t) => {
  let calls = 0;
  const ids = [];
  const b = await setup(t, async (bin, args) => {
    assert.equal(bin, "lark");
    ids.push(args.at(-1));
    if (++calls === 1) throw new Error("network down");
    return JSON.stringify({ ok: true, data: { message_id: "sent" } });
  });
  await b.reply("reply", "hello");
  await b.flush();
  assert.equal(b.state.outbox[0].status, "pending");
  b.state.outbox[0].nextAttempt = 0;
  await b.flush();
  assert.equal(b.state.outbox[0].status, "sent");
  assert.equal(ids[0], ids[1]);
  assert.equal(b.state.jobs.length, 0);
});
test("offline polling keeps cursor if pagination fails, deduplicates on recovery", async (t) => {
  let fail = true;
  const b = await setup(t, async (_, args) => {
    if (args.includes("--page-token")) {
      if (fail) throw new Error("offline");
      return JSON.stringify({
        ok: true,
        data: { messages: [msg("om_second")], has_more: false },
      });
    }
    return JSON.stringify({
      ok: true,
      data: { messages: [msg("om_first")], has_more: true, page_token: "next" },
    });
  });
  b.state.since = "2026-01-01T00:00:00Z";
  b.state.chats[config.chatId].since = b.state.since;
  await assert.rejects(() => b.poll());
  assert.equal(b.state.since, "2026-01-01T00:00:00Z");
  fail = false;
  await b.poll();
  assert.equal(b.state.jobs.length, 2);
  assert.notEqual(b.state.since, "2026-01-01T00:00:00Z");
});
test("cancel aborts current operation and pending work", async (t) => {
  const b = await setup(t);
  await b.accept(msg());
  b.controller = new AbortController();
  b.activeScope = b.ownerScope;
  await b.accept(msg("om_stop", "停止"));
  assert.equal(b.state.jobs[0].status, "cancelled");
  assert.equal(b.controller.signal.aborted, true);
});
test("model calls reuse captured session and reset starts fresh", async (t) => {
  const argsSeen = [];
  const b = await setup(t, async (bin, args, options) => {
    if (bin === "lark") return JSON.stringify({ ok: true, data: {} });
    argsSeen.push(args);
    options.onEvent({ type: "thread.started", thread_id: "thread-fixed" });
    await fs.writeFile(
      args[args.indexOf("-o") + 1],
      JSON.stringify({ answer: "收到", artifacts: [] }),
    );
    return "";
  });
  await b.accept(msg("om_1"));
  await b.work();
  await b.accept(msg("om_2", "接着说"));
  await b.work();
  assert.ok(argsSeen[1].includes("resume"));
  assert.ok(argsSeen[1].includes("thread-fixed"));
  await b.accept(msg("om_3", "新对话"));
  await b.work();
  assert.equal(b.state.scopes[b.ownerScope].conversation.threadId, null);
});
test("artifact symlinks cannot escape task folder", async (t) => {
  const b = await setup(t),
    dir = path.join(b.root, "artifacts");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(b.root, "secret.txt"), "private");
  await fs.symlink(
    path.join(b.root, "secret.txt"),
    path.join(dir, "result.txt"),
  );
  await assert.rejects(
    () =>
      b.validateArtifacts(
        [{ path: path.join(dir, "result.txt"), kind: "file" }],
        dir,
      ),
    /越界/,
  );
  assert.equal(inside("/jobs/a", "/jobs/ab/image.png"), false);
});
test("subprocess abort ends a running process", async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, /取消/);
});

const employeeEvent = (user, chat, id, content) => ({
  type: "im.message.receive_v1",
  chat_type: "p2p",
  sender_type: "user",
  sender_id: user,
  chat_id: chat,
  message_id: id,
  message_type: "text",
  content,
  create_time: String(Date.now()),
});
test("events register only private human chats, never groups", async (t) => {
  const b = await setup(t);
  b.config = { ...config, teamMode: true };
  await b.ingestEvent({
    ...employeeEvent("ou_a", "oc_a", "om_a", "hello"),
    chat_type: "group",
  });
  assert.equal(b.state.jobs.length, 0);
  await b.ingestEvent(employeeEvent("ou_a", "oc_a", "om_a", "hello"));
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_b", "hi"));
  assert.notEqual(b.state.jobs[0].scope, b.state.jobs[1].scope);
  assert.equal(Object.keys(b.state.scopes).length, 3);
  await assert.rejects(
    () => b.ingestEvent(employeeEvent("ou_b", "oc_a", "om_spoof", "bad")),
    /绑定/,
  );
});
test("employee stop, status and retry cannot affect another employee", async (t) => {
  const b = await setup(t);
  b.config = { ...config, teamMode: true };
  await b.ingestEvent(employeeEvent("ou_a", "oc_a", "om_a", "secret A"));
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_b", "secret B"));
  const [a, bjob] = b.state.jobs;
  b.controller = new AbortController();
  b.activeScope = a.scope;
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_stop_b", "停止"));
  assert.equal(a.status, "queued");
  assert.equal(bjob.status, "cancelled");
  assert.equal(b.controller.signal.aborted, false);
  a.status = "failed";
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_retry_b", "重试"));
  assert.equal(b.state.jobs.length, 2);
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_status_b", "状态"));
  const answer = b.state.outbox.at(-1).text;
  assert.ok(!answer.includes(a.id));
  assert.ok(answer.includes(bjob.id));
});
test("two employees use separate threads, directories, references and reset", async (t) => {
  const calls = [];
  const b = await setup(t, async (bin, args, opts) => {
    if (bin === "lark") return JSON.stringify({ ok: true, data: {} });
    const thread = args.includes("resume")
      ? args[args.indexOf("resume") + 1]
      : "thread-" + calls.length;
    calls.push({ args, input: opts.input, cwd: opts.cwd, thread });
    opts.onEvent({ type: "thread.started", thread_id: thread });
    await fs.writeFile(
      args[args.indexOf("-o") + 1],
      JSON.stringify({ answer: "ok", artifacts: [] }),
    );
    return "";
  });
  b.config = { ...config, teamMode: true };
  await b.ingestEvent(employeeEvent("ou_a", "oc_a", "om_a1", "A"));
  await b.work();
  const a = b.state.jobs[0];
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_b1", "B"));
  await b.work();
  const bj = b.state.jobs[1];
  assert.notEqual(calls[0].thread, calls[1].thread);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  b.state.scopes[a.scope].conversation.attachments.push({
    path: "/private-A.png",
    kind: "image",
  });
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_b2", "follow-up"));
  await b.work();
  assert.equal(calls[2].thread, calls[1].thread);
  assert.ok(!calls[2].input.includes("/private-A.png"));
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_b_reset", "新对话"));
  await b.work();
  assert.equal(b.state.scopes[bj.scope].conversation.threadId, null);
  assert.equal(b.state.scopes[a.scope].conversation.threadId, calls[0].thread);
  const restart = new Bridge(b.root, b.config, { run: b.run });
  await restart.init();
  assert.equal(
    restart.state.scopes[a.scope].conversation.threadId,
    calls[0].thread,
  );
});
test("delivery destinations stay tied to the originating employee", async (t) => {
  const sent = [];
  const b = await setup(t, async (_, args) => {
    sent.push(args);
    return JSON.stringify({ ok: true, data: { message_id: "sent" } });
  });
  b.config = { ...config, teamMode: true };
  await b.ingestEvent(employeeEvent("ou_a", "oc_a", "om_aa", "帮助"));
  await b.ingestEvent(employeeEvent("ou_b", "oc_b", "om_bb", "帮助"));
  await b.flush();
  assert.equal(sent[0][sent[0].indexOf("--message-id") + 1], "om_aa");
  assert.equal(sent[1][sent[1].indexOf("--message-id") + 1], "om_bb");
  assert.deepEqual(
    b.state.outbox.map((x) => x.chatId),
    ["oc_a", "oc_b"],
  );
});
