# Security & Best Practices Playbook

> **Reusable for any project.** Copy this file into any repository and adapt the
> project-specific sections. The principles and guardrails are universal.

---

## 1. Agent Guardrails — How the AI Operates

These are the rules I (the AI agent) follow when working on any project. You can hold me
accountable to them.

### 1.1 — Secrets & Credentials

| Rule | Why |
|------|-----|
| I NEVER write real API keys, passwords, or tokens into code | Leaked credentials are the #1 cause of security breaches |
| I NEVER put real credentials in documentation, examples, or demos | Documentation is often public; examples get copied |
| I ALWAYS use placeholder values like `YOUR_API_KEY_HERE` | Clear signal that the user must replace this |
| I ALWAYS verify the `.gitignore` before adding files | Prevents accidental commits of sensitive files |
| I ALWAYS `git status` before committing to check what's staged | Catches unintended files before they're committed |
| I NEVER commit `.env` files, `.env.local`, or any environment files | Standard practice across all frameworks |
| I NEVER commit `config.json` unless it's a template | Config files often contain secrets |
| I ALWAYS warn the user if I detect a file might contain secrets | Extra layer of protection |

### 1.2 — Code Quality

| Rule | Why |
|------|-----|
| I ALWAYS check the exit code of every command before proceeding | A failed command is a signal to stop and investigate |
| I NEVER ignore a non-zero exit code | Fail fast, fail safe |
| I ALWAYS run type-checking before committing | Catches type errors, missing imports, broken interfaces |
| I ALWAYS run tests before committing | Tests are the gate — if they fail, something is wrong |
| I NEVER skip the verification step | No "it works on my machine" — verification is the contract |
| I ALWAYS read a file before editing it | Prevents data loss and ensures context is correct |
| I ALWAYS verify what's staged with `git status` + `git diff --cached` | Avoids accidental commits of unintended files |

### 1.3 — Communication & Transparency

| Rule | Why |
|------|-----|
| I ALWAYS tell the user what files I'm creating or modifying | Transparency builds trust |
| I ALWAYS explain why I'm making a particular choice | Context matters for security decisions |
| I ALWAYS flag risks — if something could be dangerous, I say so | Better to be cautious than sorry |
| I NEVER proceed without confirmation on potentially destructive actions | Force push, history rewrite, mass delete — all require explicit consent |

---

## 2. Project Guardrails — Repository Setup

### 2.1 — The Universal `.gitignore`

A good `.gitignore` has two parts: universal patterns (every project should have these)
and project-specific patterns (language/framework-specific).

#### Universal Patterns (Every Project Needs These)

```gitignore
# SECURITY — NEVER COMMIT THESE
.env
.env.*
*.env
credentials*
config.json
config.*.json
!config.template.json
secrets*
*.key
*.pem
*.cert
*.p12
*.pfx
*.keystore
kubeconfig*
kube-config*

# DEPENDENCIES
node_modules/
vendor/
bundle/
.gems/
.venv/
venv/
__pycache__/
*.pyc
target/
*.class
*.jar
*.war

# BUILD OUTPUT
dist/
build/
out/
.next/
.nuxt/
_site/

# DATABASES
*.db
*.sqlite
*.sqlite3

# LOGS
*.log
npm-debug.log*
pnpm-debug.log*
yarn-debug.log*
yarn-error.log*

# IDE & OS
.vscode/settings.json
.idea/
*.swp
*.swo
*~
.DS_Store
Thumbs.db
Desktop.ini

# CACHE
.npm-cache/
.pnpm-store/
.cache/
.turbo/
.eslintcache
.mypy_cache/
.ruff_cache/
```

#### Project-Specific Additions

| Project Type | Additional Patterns |
|-------------|-------------------|
| Node.js | `node_modules/`, `npm-debug.log*`, `pnpm-lock.yaml` |
| Python | `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `*.egg-info/`, `.mypy_cache/` |
| Rust | `target/`, `Cargo.lock` (for libraries) |
| Go | `vendor/` (if not committed), `*.exe` |
| Java/Kotlin | `build/`, `.gradle/`, `*.class`, `*.jar`, `*.war` |
| Docker | `.dockerignore` (separate from `.gitignore`) |
| Terraform | `*.tfstate`, `*.tfstate.*`, `crash.log`, `override.tf` |
| Kubernetes | `kubeconfig*`, `*.kubeconfig` |

### 2.2 — Template Files (The Safe Alternative)

Never commit real config files. Always commit a template with placeholder values:

```
project/
  config.template.json    # Committed — placeholder values like "YOUR_API_KEY_HERE"
  config.json             # Gitignored — real values (copy from template)
  .env.example            # Committed — placeholder values
  .env                    # Gitignored — real values (copy from example)
  .gitignore              # Must include config.json and .env
```

Setup workflow:
```bash
cp config.template.json config.json
# Edit config.json with your real values
# The file is in .gitignore — safe from accidental commits
```

### 2.3 — Pre-Commit Hook (Universal)

A pre-commit hook runs before every commit and blocks it if dangerous patterns are found.

| Check | Blocks commit? |
|-------|:------------:|
| `config.json` being committed | YES |
| `config.*.json` being committed | YES |
| `.env` files being committed | YES |
| `*credentials*` files | YES |
| `*.key`, `*.pem`, `*.p12` files | YES |
| Large files > 1MB | WARNING |
| Files with potential API keys | WARNING |
| Files with `BEGIN RSA PRIVATE KEY` | YES |
| Debug statements (`console.log`, `print`, `debugger`) | WARNING |

Installation:
```bash
git config core.hooksPath .githooks
```

### 2.4 — Branch Protection Rules

| Rule | Why |
|------|-----|
| Require pull request review | No direct pushes to main |
| Require status checks (CI/tests pass) | No broken code merged |
| Require up-to-date branches | No stale base branches |
| Restrict force pushes | Prevents history rewrites on shared branches |
| Restrict deletions | Prevents accidental branch deletion |

---

## 3. Secrets Management

### 3.1 — NEVER Store Secrets Here

| Bad | Reason |
|-----|--------|
| In code files | Committed to git, visible to everyone |
| In config files in the repo | Same problem |
| In environment variables in .env committed | Publicly visible |
| In documentation | Users copy-paste without changing |
| In commit messages | Visible in git history forever |

### 3.2 — SAFE Ways to Store Secrets

| Good | How it works |
|------|-------------|
| Environment variables (set at runtime) | `export API_KEY="..."` — never in a committed file |
| `.env.local` (in .gitignore) | Standard for local development |
| Secret manager (AWS Secrets Manager, GCP Secret Manager, Vault) | Programmatic access, audit logs, rotation |
| GitHub Secrets (for CI/CD) | Encrypted, only available in workflows |

### 3.3 — Secret Rotation Schedule

| Secret Type | Rotate every | When else to rotate |
|-------------|-------------|-------------------|
| API keys | 90 days | After any suspected leak |
| Database passwords | 180 days | After employee leaves |
| SSH keys | 365 days | After any suspected compromise |

---

## 4. Git Hygiene

### 4.1 — The 5-Second Pre-Commit Check

```bash
# 1. Check what's changed
git status

# 2. Check the actual content of staged files
git diff --cached --name-only

# 3. If any file looks suspicious, inspect it
git diff --cached <suspicious-file>

# 4. Check for secrets in the diff
git diff --cached | grep -iE "api[key]|secret|password|token" || true

# 5. Only then commit
git commit -m "<type>: <description>"
```

### 4.2 — If You Accidentally Commit a Secret

```bash
# 1. IMMEDIATELY revoke the secret on the service
#    Do NOT wait — the secret may already be compromised.

# 2. Remove the file from tracking
git rm --cached <file-with-secret>
echo "<file-with-secret>" >> .gitignore

# 3. Amend the commit (if not pushed yet)
git commit --amend

# 4. If pushed, rewrite history (DANGEROUS — only if alone on the branch)
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch <file-with-secret>' \
  --prune-empty -- --all

# 5. Force push
git push origin --force

# 6. Purge old references
git for-each-ref --format='%(refname)' refs/original/ | while read ref; do
  git update-ref -d "$ref"
done
git reflog expire --expire=now --all
git gc --aggressive --prune=now

# 7. GitHub may still have the secret cached. Check secret scanning alerts.
```

### 4.3 — Commit Message Convention

```
<type>: <brief description>

<optional body explaining why (not what)>
```

| Type | When to use |
|------|------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `sec` | Security fix or guardrail |
| `refactor` | Code restructuring |
| `test` | Adding or updating tests |
| `chore` | Maintenance, dependencies, tooling |

---

## 5. Dependency Security

### 5.1 — Before Adding a Dependency

| Check | Why |
|-------|-----|
| Is it maintained? | Last commit < 1 year? Abandoned. |
| Is it popular? | < 100 stars/week? Higher risk of bugs. |
| Does it have known vulnerabilities? | Run `npm audit`, `pip audit`, `cargo audit` |
| Does it have a license? | No license = legal risk. |

### 5.2 — Audit Commands

```bash
# Node.js
npm audit              # Check for vulnerabilities
npm outdated           # Check for outdated packages

# Python
pip audit              # Check for vulnerabilities
pip list --outdated    # Check for outdated packages

# Rust
cargo audit            # Check for vulnerabilities
cargo outdated         # Check for outdated packages

# Go
govulncheck ./...      # Check for vulnerabilities
```

### 5.3 — Lock Files

| File | Language | Always commit? |
|------|----------|:-------------:|
| `package-lock.json` | Node.js | YES |
| `pnpm-lock.yaml` | Node.js (pnpm) | YES |
| `yarn.lock` | Node.js (Yarn) | YES |
| `Cargo.lock` | Rust | YES (applications) |
| `go.sum` | Go | YES |
| `Pipfile.lock` | Python (pipenv) | YES |

---

## 6. Code Review & Quality

### 6.1 — Pre-Merge Review Checklist

- [ ] Does the code compile/type-check?
- [ ] Do all tests pass?
- [ ] Are there tests for the new code?
- [ ] Are there NO secrets in the code?
- [ ] Are there NO debug statements left in?
- [ ] Is the .gitignore updated if new generated files were introduced?
- [ ] Are error cases handled?
- [ ] Is the documentation updated?
- [ ] Does the commit message follow the convention?

### 6.2 — The "Bus Factor" Principle

| Bad Practice | Good Practice |
|-------------|---------------|
| No comments | Clear comments explaining WHY (not what) |
| Magic numbers | Named constants |
| 300-line functions | Small, focused functions |
| Side effects everywhere | Pure functions where possible |
| Untested code | Tests for every public function |

---

## 7. Incident Response — Secrets Leaked

### 7.1 — Immediate Actions (First 5 Minutes)

1. **REVOKE THE SECRET** — Go to the service (Bybit, AWS, GitHub, etc.) and delete/rotate the compromised key immediately. Do NOT wait — the secret is already exposed.
2. **STOP THE COMMIT** — If not pushed: amend the commit. If pushed: prepare for force push.
3. **ASSESS THE DAMAGE** — Was the repo public or private? How long was the secret exposed? Check for unauthorized access.

### 7.2 — Cleanup Commands

```bash
git rm --cached <file-with-secret>
echo "<file-with-secret>" >> .gitignore
git commit --amend

git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch <file-with-secret>' \
  --prune-empty -- --all
git push origin --force

git for-each-ref --format='%(refname)' refs/original/ | while read ref; do
  git update-ref -d "$ref"
done
git reflog expire --expire=now --all
git gc --aggressive --prune=now
```

### 7.3 — Prevention for Next Time

- Add the file pattern to `.gitignore` immediately
- Install the pre-commit hook
- Rotate ALL other secrets as a precaution
- Review who has access to the repository

---

## 8. Checklist — Before Every Commit

```
[ ] git status — checked what files are changed
[ ] git diff --cached — reviewed what's actually staged
[ ] No secrets in the staged files (API keys, passwords, tokens)
[ ] No config.json or .env files staged
[ ] No debug statements left in
[ ] Type-checking passes
[ ] Tests pass
[ ] All new files are listed above
[ ] Commit message follows convention
```

---

## 9. Templates

### 9.1 — Universal Pre-Commit Hook

Save as `.githooks/pre-commit` in any repository:

```bash
#!/bin/sh
echo "Scanning for exposed secrets..."

FORBIDDEN="config.json .env .env.local credentials.json *.key *.pem"

for f in $FORBIDDEN; do
    if git diff --cached --name-only | grep -q "^$f$"; then
        echo "BLOCKED: '$f' contains secrets and cannot be committed."
        exit 1
    fi
done

git diff --cached --name-only | while read -r file; do
    case "$file" in *.template.*|*.md|*.sh) continue ;; esac
    if git show :"$file" 2>/dev/null | grep -qiE "api[key]|secret|password"; then
        echo "WARNING: '$file' may contain secrets."
    fi
done

echo "Scan complete."
```

### 9.2 — Universal `.gitignore` Template

Save as `.gitignore` in any new repository:

```gitignore
# SECURITY
.env
.env.*
*.env
credentials*
config.json
config.*.json
!config.template.json
secrets*
*.key
*.pem
*.cert
*.p12
*.pfx

# DEPENDENCIES
node_modules/
vendor/
.venv/
venv/
__pycache__/
*.pyc
target/

# BUILD
dist/
build/
out/

# LOGS
*.log

# OS
.DS_Store
Thumbs.db
```

---

## 10. Quick Reference Card

### Before every commit (10 seconds)

```
git status
git diff --cached --name-only
# Check for secrets
# Type-check
# Test
git commit -m "<type>: <description>"
```

### Before every push (30 seconds)

```
git log --oneline -3
git push
```

### If something goes wrong

```
git revert HEAD       # Undo last commit (safe)
git commit --amend    # Fix last commit (safe if not pushed)
git push --force      # DANGEROUS — only if alone on branch