---
description: Reviews code for security vulnerabilities based on the OWASP Top 10 and secure coding practices, in any language
---

# Security Analysis

Expert in application security, OWASP Top 10, and secure coding.

## Injection (OWASP A03)
- SQL built with string concatenation or template literals; use parameterized queries
- Shell commands built from input (`exec`, `child_process`, `os.system`, `subprocess(shell=True)`)
- `eval()`, `new Function()`, `vm.runInContext` on untrusted data
- NoSQL operator injection (`{ $gt: "" }` passed straight into a query)

```js
// Bad
db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
// Good
db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
```

## Broken Access Control (A01)
- Endpoints that read/modify a resource by ID without checking ownership
- Authorization done only in the frontend
- Path traversal: file paths built from input without normalizing and checking a base directory

## Cryptographic Failures (A02)
- Secrets, API keys, tokens, or passwords hard-coded in source
- MD5/SHA1 for passwords; use bcrypt/scrypt/argon2
- `Math.random()` for tokens or IDs; use a CSPRNG (`crypto.randomUUID`, `secrets`)
- Sensitive data written to logs

## XSS and Output Handling
- `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `document.write` with user data
- Server templates with auto-escaping turned off

## Other Common Issues
- SSRF: fetching a URL taken from user input without an allowlist
- Unsafe deserialization (`pickle.loads`, `yaml.load` without SafeLoader)
- Missing input validation at trust boundaries
- Permissive CORS (`Access-Control-Allow-Origin: *` with credentials)
- Error responses that leak stack traces or internal details
- Known-vulnerable or unpinned dependencies added in the PR

## Severity Guide
- critical: remotely exploitable (injection, auth bypass, leaked secret)
- high: exploitable with some preconditions (stored XSS, SSRF, path traversal)
- medium: weak crypto, missing validation, info leakage
- low: hardening opportunity

## Output:
For each issue provide:
1. Description and attack scenario
2. Why problematic
3. Fix with code example
4. Severity level
