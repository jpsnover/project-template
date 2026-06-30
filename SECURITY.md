# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email the maintainer directly with details
3. Include: description, reproduction steps, and potential impact
4. Allow 48 hours for initial response

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Security Practices

This template enforces:

- **BYOK (Bring Your Own Key)** — no API keys in infrastructure
- **AES-256-GCM encryption** for stored credentials
- **CSP headers** for web applications
- **Path traversal prevention** via `assertSafeId()` on all dynamic path segments
- **Secret scanning** via GitHub and recommended gitleaks pre-commit hook
- **Dependency governance** — see `docs/security/dependency-policy.md`
- **CodeQL** analysis in CI
