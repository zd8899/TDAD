# Review & Commit — TDAD VS Code Extension

You are an expert software architect reviewing and committing changes to the TDAD (Test-Driven AI Development) VS Code extension.

Follow every phase below **in order**. Do NOT skip phases. Report findings clearly to the user before making any changes.

---

## CONTEXT: TDAD Architecture

### What This Project Is

TDAD is a VS Code extension for workflow-based app building with multi-model AI code generation. It enforces a Plan > Spec > Test > Fix cycle where automated tests validate every line, ensuring working software.

### Clean Architecture Layers

| Layer | Path | Purpose | Import Rules |
|---|---|---|---|
| **Core** | `/src/core/` | Business logic (ai, nodes, templates, testing, workflows, prompts) | NEVER imports from infrastructure/presentation/vscode-integration |
| **Infrastructure** | `/src/infrastructure/` | Technical implementations (database, parsing, storage, navigation) | MAY import from core |
| **Presentation** | `/src/presentation/webview/` | React UI components (.tsx, handlers, hooks, utils) | MAY import from core and infrastructure |
| **VSCode Integration** | `/src/vscode-integration/` | VSCode APIs (bootstrap, controllers, providers) | Coordinates all layers |
| **Shared** | `/src/shared/` | Cross-layer code (config, types, utils) | Imported by ALL layers |
| **Styles** | `/src/styles/` | All CSS files (.css) go here ONLY | N/A |
| **Entry** | `/src/extension.ts` | Extension entry point | N/A |

### Key Subsystems

- **Prompt System**: Template-based `.md` files in `/src/core/prompts/` with Handlebars-like syntax. Copied to `.tdad/prompts/` for user customization.
- **Autopilot**: Automated BDD > Test > Run+Fix pipeline. Supports single-node and multi-feature (regression) modes.
- **Golden Packet**: The context packet sent to AI agents with specs, test results, traces, and rules.
- **Canvas**: React-based workflow editor rendered in a VSCode webview.

---

## PHASE 1: DISCOVERY

Run in parallel:

```
git status
git diff --stat
git diff
git log --oneline -5
```

**Read every modified/new file completely.** Understand the full diff before reviewing.

**Output a summary table:**
| Category | Files |
|---|---|
| Modified | |
| New | |
| Deleted | |
| Staged (unrelated) | |

---

## PHASE 2: FILE SIZE AUDIT

For every changed/new file, check line count.

**Rules:**
- **Hard limit:** No file may exceed **1000 lines**
- **Target:** If a file exceeds 1000 lines, refactor it to ~500 lines per file
- **How to split:**
  - **TypeScript (.ts):** Extract related methods into separate service/util files in the same directory
  - **React (.tsx):** Extract sub-components, hooks into sibling files
  - **CSS (.css):** Split by feature/component
- **Exceptions:** Auto-generated files are exempt
- **Do NOT split** if it would break logical cohesion

**Output a table of files exceeding the limit:**
| File | Lines | Action |
|---|---|---|

---

## PHASE 3: ARCHITECTURE REVIEW

### 3a. Layer Boundary Violations

Check every import in changed files:
- Core MUST NOT import from infrastructure, presentation, or vscode-integration
- Shared types/interfaces MUST live in `/src/shared/types/index.ts` (no local redefinitions)
- CSS files MUST be in `/src/styles/` only (NOT in presentation/webview/styles/ or anywhere else)
- Webview components (.tsx) CAN import from `../../shared/types` (works with bundler)

### 3b. Code Duplication

- Same logic must NOT exist in multiple places
- If repeated code is found, it should be extracted to a shared location
- Check that prompt content is not duplicated between templates and TypeScript code
- Constants and interfaces must be defined once in `/src/shared/types/`

### 3c. Pattern Compliance

- **Logging:** Use `Logger` from `/src/shared/utils/Logger.ts` (NEVER `console.log`)
- **Types:** All shared interfaces/types in `/src/shared/types/index.ts`
- **CSS:** All `.css` files in `/src/styles/`
- **No unnecessary fallbacks:** Don't add fallback logic unless explicitly needed
- **No unnecessary documentation:** Don't add docstrings/comments to unchanged code

### 3d. Template System Consistency

For prompt template changes:
- Templates use `{{variable}}`, `{{#if var}}`, `{{#each array}}` syntax
- Templates must be registered in `PromptService.ensureWorkspaceTemplates()` and `markTemplatesAsApplied()`
- Template variables must be passed from the calling code in `PromptGenerationService`
- `golden-packet.md` = single-feature fix prompt
- `golden-packet-multi-feature.md` = multi-feature/regression fix prompt (self-contained)

### 3e. Security Check

- No hardcoded secrets or credentials
- No command injection vectors in CLI integration
- No XSS in webview components

---

## PHASE 4: FUNCTIONAL REVIEW

### 4a. Does It Work?

- Are all code paths reachable?
- Are async/await patterns correct?
- Are error cases handled (but not over-engineered)?
- For template changes: will the template processor correctly handle the syntax?

### 4b. Autopilot Integration

If changes touch autopilot/automation:
- Dialog props flow correctly (TSX > canvas-app > provider > handler)
- State types match in `automation.ts`
- Test runner commands are correct
- AGENT_DONE.md signal handling is intact

### 4c. Dead Code

- Flag unused imports, variables, methods
- Flag commented-out code (should be removed)
- Flag TODO/FIXME that should be resolved in this commit

---

## PHASE 5: REPORT

Present a clear report:

1. **Summary** - One paragraph describing what changed
2. **File Size Issues** - Table of files >1000 lines
3. **Architecture Issues** - Numbered list with severity (Critical/High/Medium/Low)
4. **Duplication Issues** - Specific locations
5. **Recommended Fixes** - Prioritized list

**Ask the user:** "Should I apply these fixes before committing, or commit as-is?"

---

## PHASE 6: FIX (if approved)

Apply fixes in priority order:
1. Critical architecture violations (layer boundaries, type duplication)
2. Code duplication removal
3. File size splits
4. Pattern compliance fixes
5. Dead code removal

For each fix:
- Read the file first
- Make minimal, focused changes
- Preserve existing style
- Do NOT add unnecessary abstractions
- Do NOT "improve" unrelated code

---

## PHASE 7: COMMIT

1. Run `git status` and `git diff --stat` to confirm final state
2. Check for staged changes from previous work — unstage anything unrelated
3. Stage relevant files (specific files, NOT `git add .` or `git add -A`)
4. Craft a commit message:

```
<type>(<scope>): <short description>

<body — what changed and why>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**Types:** feat, fix, refactor, docs, style, test, chore
**Scopes:** prompts, automation, canvas, testing, ui, core, shared, infra

5. Create the commit (use HEREDOC for message)
6. Report the commit hash and summary

---

## IMPORTANT RULES

- **Never push** without explicit user approval
- **Never compile** unless the user asks (`npm run compile`)
- **Never modify test files** to make them pass — fix the app code
- **Never create documentation** unless explicitly requested
- **Never delete user work** — if unsure, ask
- **Read before edit** — always read files before modifying
- **Preserve formatting** — match the existing code style
- **Minimal changes** — fix what's needed, don't "improve" unrelated code
- **No console.log** — use Logger
- **No fallbacks** unless explicitly asked
- **Remove old code** when refactoring (no backward compatibility shims)
