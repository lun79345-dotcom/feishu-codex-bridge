# Feishu Codex Bridge

Turn a Feishu bot into a self-hosted Codex assistant: continuous conversations, image generation, and file delivery, with separate conversations for each employee.

[中文部署指南](docs/README.zh-CN.md) · [Security](SECURITY.md) · [MIT License](LICENSE)

## What it does

- Private-message conversations backed by persistent Codex threads.
- Image generation/editing when available to the signed-in Codex account, plus image and document input.
- Per-employee task queues, conversations, attachments, and reply destinations.
- Durable message deduplication and delivery retries, without regenerating an answer on delivery failure.
- Feishu event consumption and history polling for known private chats.
- `帮助`, `状态`, `新对话`, `停止`, and `重试` commands (optional `/` prefix).

```text
Feishu private message → Lark CLI → persistent queue → Codex CLI
                                ← text / images / files ←
```

## Status and requirements

Experimental, self-hosted software. The original deployment was tested on macOS with Lark CLI 1.0.97 and Codex CLI 0.162.0-alpha.2. This is **not a claim of compatibility with every Codex release**: custom filesystem permissions, feature flags, structured output, and image generation must be supported by your installed version. Windows and Linux deployment have not been validated. There are no npm runtime dependencies; use Node.js 22 or newer.

The host must stay awake and online. There is one worker across all employees; account usage is shared. This is not a hosted service, an official OpenAI/Feishu integration, or an enterprise tenant-isolation platform. Review your providers' account and organizational requirements before offering shared access.

## Quick start (macOS)

1. Install Node.js, [Codex CLI](https://github.com/openai/codex), and the official [Lark CLI](https://www.npmjs.com/package/@larksuite/cli). Complete Codex sign-in on the deployment host. Image generation availability depends on your account and CLI version.
2. Set up your own Feishu app/bot. Use `lark-cli config init --help` and `lark-cli auth login --help` for the installed CLI's setup flow; keep secrets in its credential store. Publish the app with message receive events (`im.message.receive_v1`) and the permissions needed to read private messages, reply, and transfer attachments. Limit app visibility to intended users.
3. Check `lark-cli auth status` and `lark-cli event consume --help`. Ensure the CLI's active app is the intended bot; the bridge does not select an app profile for you.
4. Prepare the configuration:

   ```sh
   cp bridge.config.example.json bridge.config.json
   ```

   Set `chatId` to the owner's bot private chat (`oc_…`) and `allowedUserId` to that owner's open ID (`ou_…`). Set `lark` and `codex` to executable paths or commands on PATH. Select a model actually available to your account. The example retains the original deployment's `gpt-6.1-sol` / `medium` settings.
5. Test and run in the foreground:

   ```sh
   npm test
   npm start
   ```

   Confirm `event receiver ready`, then privately message your bot. Start in owner-only mode (`teamMode: false`); verify isolation and app visibility before enabling employees with `teamMode: true`.

Only one deployment should consume messages for the same bot. Stop the previous deployment and its app-specific event bus before switching hosts. Never copy someone else's account credentials into your installation.

## Configuration

| Field | Meaning |
| --- | --- |
| `lark`, `codex` | CLI executable paths; services need a suitable PATH |
| `chatId`, `allowedUserId` | Owner's private chat and open ID |
| `model`, `reasoningEffort` | Explicit Codex model and reasoning strength |
| `teamMode` | Accept new employee private chats within app visibility; defaults to owner-only in the example |
| `pollSeconds` | History polling interval, 8 seconds by default |
| `maxQueue`, `dailyLimit` | Per-employee queue and daily limits; daily boundary uses Asia/Shanghai |
| `taskTimeoutMs` | Per-task timeout; default 15 minutes |

Messages and attachments are saved locally. `.bridge/` contains state, event inbox, and logs; `output/` contains employee working directories and generated artifacts. They and the real config are ignored by Git. No credentials, employee history, or generated content are included in this repository.

## Operations and limitations

- See the [Chinese deployment guide](docs/README.zh-CN.md) for background startup and stopping the app-specific connection.
- History polling recovers messages for known chats. A new user who first contacts the bot while the host is offline may need to send another message after it returns.
- Interrupted jobs are not automatically rerun; the employee can use `重试`. Delivery failures retry existing results.
- Group chats, voice/video messages, desktop control, and sending to unrelated chats are unsupported. Responses are not streamed token by token.
- Up to four input attachments and five output artifacts per turn; files are limited to 20 MB. Document parsing depends on tools installed in the sandbox. Image generation is requested to produce at most two images per turn; this is a prompt limit, not a billing guarantee.
- Resetting a conversation does not delete old files. Operators must manage retention, backups, log growth, and storage capacity.
- The Codex subprocess has restricted filesystem access; the outer bridge and Lark CLI run with the host account's permissions. Read [SECURITY.md](SECURITY.md) before team use.

## Verification

`npm test` runs mocked bridge tests for authorization, deduplication, recovery, delivery retries, thread continuity, cancellation, file path validation, employee separation, and reply routing. Tests do not contact Feishu or consume model quota. The original macOS deployment also completed real-model two-conversation memory, file output, image generation, and OS-level cross-directory-denial checks. Those deployment-specific checks are not bundled as reproducible CI tests, and a real second-employee end-to-end test was still pending at export.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Useful next steps include Linux/Windows validation, bounded log retention, and reproducible sandbox integration tests. Please do not submit account data or tokens in issues.
