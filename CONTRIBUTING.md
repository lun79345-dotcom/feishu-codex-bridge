# Contributing

Use Node.js 22 or newer and run `npm test` before submitting changes. There are no runtime npm dependencies.

Keep test fixtures synthetic. Never commit real Feishu IDs, private messages, generated employee artifacts, secrets, or machine-specific paths. Changes to authorization, reply routing, file access, cancellation, or persistence should include meaningful regression tests. Document CLI version assumptions and OS-specific behavior.

CI exercises mocked behavior on macOS. It does not validate live authentication, Feishu event permissions, image generation, or actual OS sandbox enforcement. Do not claim those guarantees from CI alone.

By contributing, you agree that your contributions are licensed under the MIT License.
