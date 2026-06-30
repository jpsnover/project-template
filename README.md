# Project Template

Reusable project template with production-grade infrastructure extracted from [AI Triad Research](https://github.com/jpsnover/ai-triad-research).

## What You Get

| Component | Description |
|-----------|-------------|
| **Flight Recorder** | Ring-buffer diagnostic recorder with NDJSON dumps |
| **AI Client** | Multi-backend abstraction (Claude, Gemini, Groq, OpenAI, DeepSeek, Ollama) |
| **Resilience Framework** | Circuit breaker, adaptive throttle, retry with backoff |
| **Runtime Config** | Hot-reloadable JSON config with admin REST endpoints |
| **Feature Flags** | Server + client flag evaluation, no external dependency |
| **Error Handling** | ActionableError with Goal/Problem/Location/Next Steps |
| **Key Management** | BYOK model with AES-256-GCM encryption, key rotation |
| **Fault Injection** | Declarative test harness for failure-path testing |
| **Rate Limiter** | Sliding-window per-user/session rate limiting |
| **CI/CD** | GitHub Actions workflows for test, build, deploy (Azure) |
| **Code Review Guides** | TypeScript and Python review checklists for AI agents |
| **Security** | CSP headers, path traversal prevention, secret scanning |

## Quick Start

1. Click **"Use this template"** on GitHub to create your repo
2. Clone your new repo
3. Copy `.env.example` to `.env` and add your API keys
4. `cd app && npm install && npm run dev`

## Directory Layout

```
project-root/
├── .github/workflows/     # CI/CD pipelines
├── lib/                   # Shared libraries
│   ├── ai-client/         # Multi-backend AI abstraction
│   └── flight-recorder/   # Diagnostic ring-buffer recorder
├── app/                   # Primary application
│   └── src/
│       ├── main/          # Electron main process / Node.js entry
│       ├── renderer/      # React UI layer
│       └── server/        # Express/Node.js server
├── scripts/               # PowerShell module + automation
├── deploy/azure/          # Bicep IaC + Dockerfiles
├── docs/                  # Internal documentation
├── docs-public/           # External user-facing docs
├── tests/                 # PowerShell Pester tests
└── evals/                 # AI evaluation framework
```

## Documentation

- [Architecture](docs/architecture.md) — system overview and dependency rules
- [Error Handling](docs/error-handling.md) — ActionableError standard
- [Security](docs/security/threat-model.md) — threat model and hardening
- [Flight Recorder](docs/flight-recorder-guide.md) — usage and configuration
- [Code Review: TypeScript](docs/CodeReview/typescript-review-guide.md)
- [Code Review: Python](docs/CodeReview/python-review-guide.md)

## Assumptions

- **GitHub + Azure** — CI via GitHub Actions, hosting via Azure Container Apps
- **AI-powered** — projects will call LLM APIs (BYOK model)
- **TypeScript + PowerShell** — primary languages (Python supported)
- **Small team** — 1-5 developers, 1-3 AI agents

## License

[MIT](LICENSE)
