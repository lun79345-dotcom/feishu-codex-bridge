# Security and data handling

This experimental bridge is intended for a trusted team on an operator-controlled host. It is not a hardened multi-tenant service and has not received an independent security audit.

## Boundaries

- Each private chat/sender pair gets a separate Codex thread and conversation directory. Commands and delivery are scoped to that employee.
- Codex custom permissions deny filesystem access by default, grant minimal system reads, system skill reads, and writes to the current conversation directory. Shell network access is disabled. Built-in web search and model services can still use their own network capabilities.
- Apps, plugins, computer use, and browser use are disabled for the worker. Delivered files must pass resolved-path, size, type, and image checks. Native images are imported only from the current Codex thread's generation directory.
- The bridge process itself, the CLI credentials, and all employee data belong to the host OS account. An administrator or a compromised bridge can access them. Prompt instructions are additional guidance, not a security boundary.
- Do not expose this installation to adversarial users. Use owner-only mode first and restrict Feishu app visibility. Verify actual sandbox enforcement on each deployment; do not disable it for compatibility.

## Stored and transmitted data

Employee prompts, attachments, generated outputs, conversation state, and diagnostic logs are stored locally. Model requests are sent through the signed-in Codex account; messages and output artifacts are sent through Feishu. Host operators must review relevant provider and organizational requirements, consent, retention, and account usage before team deployment.

Never commit real configuration, credential stores, `.bridge/`, `output/`, or employee logs. Use the example config and synthetic fixtures when reporting issues. Git ignore rules are not a secret scanner.

## Reporting

Report vulnerabilities through the repository's private vulnerability reporting feature when available. Do not publish exploit details or sensitive logs in a public issue. If private reporting is unavailable, open a minimal issue requesting a private contact route, without secrets or exploit details.
