# Lighterm AI Agent Skills

Portable Agent Skills conforming to the open [Agent Skills](https://agentskills.io) `SKILL.md` specification. Installing a skill equips any compatible AI coding agent with Lighterm's architecture rules, TypeScript/Rust plugin contracts, layout positioning rules, Settings integration conventions, and verification workflow.

---

## Available Skills

| Skill | Description | Entry |
| --- | --- | --- |
| `lighterm-plugin-development` | Design, implement, wire, and test frontend-only or full-stack Rust + Tauri v2 plugins, GUI viewports (`defaultPosition`), Settings pages, `PluginConfig`, slots, and commands for Lighterm. | [SKILL.md](./lighterm-plugin-development/SKILL.md) |

---

## How Any AI Agent Can Install It

Choose the option matching your AI coding assistant:

### 1. Universal CLI (`npx skills`)
Works across Claude Code, Cursor, Codex, Antigravity, Gemini CLI, OpenCode, Windsurf, Cline, and more:

```bash
# Install from a cloned Lighterm repository
npx skills add ./skills --skill lighterm-plugin-development

# Or install directly from the Git repository URL
npx skills add <your-git-repo-url> --skill lighterm-plugin-development
```

### 2. Google Antigravity / Gemini CLI
- **Workspace discovery (copy or symlink)**: Copy [lighterm-plugin-development](./lighterm-plugin-development/SKILL.md) directory into `.agents/skills/lighterm-plugin-development/`
- **Workspace JSON manifest (no copy needed)**: Add `.agents/skills.json` at repo root:
  ```json
  {
    "entries": [
      { "path": "skills" }
    ]
  }
  ```
- **Global install**: Copy `skills/lighterm-plugin-development/` into `~/.gemini/config/skills/lighterm-plugin-development/` (or `~/.agents/skills/lighterm-plugin-development/`).

### 3. Claude Code
- **Project**: Copy or symlink `skills/lighterm-plugin-development/` to `.claude/skills/lighterm-plugin-development/`
- **Global**: Copy or symlink `skills/lighterm-plugin-development/` to `~/.claude/skills/lighterm-plugin-development/`

### 4. Cursor
- **Project**: Copy or symlink `skills/lighterm-plugin-development/` to `.cursor/skills/lighterm-plugin-development/`
- **Global**: Copy or symlink `skills/lighterm-plugin-development/` to `~/.cursor/skills/lighterm-plugin-development/`

### 5. OpenAI Codex
- **Project**: Copy or symlink `skills/lighterm-plugin-development/` to `.codex/skills/lighterm-plugin-development/`
- **Global**: Copy or symlink `skills/lighterm-plugin-development/` to `~/.codex/skills/lighterm-plugin-development/`

### 6. Other Agents (Windsurf, Cline, Roo Code, OpenCode, etc.)
Copy `skills/lighterm-plugin-development/` into your agent's configured `skills/` directory, or point the agent directly at [skills/lighterm-plugin-development/SKILL.md](./lighterm-plugin-development/SKILL.md).

---

## Skill Layout

```text
skills/lighterm-plugin-development/
├── SKILL.md                                   # Core 5-step workflow & rules
├── references/
│   ├── frontend-kernel-and-layout.md          # PluginKernel, ViewportPosition, Settings & IPC APIs
│   ├── rust-backend-and-tauri-ipc.md          # CorePlugin trait, Storage, SSH pool & Tauri commands
│   └── testing-and-troubleshooting.md         # Vitest + cargo test templates & common pitfalls
└── examples/
    ├── frontend-only-plugin.md                # Complete frontend-only plugin template
    └── fullstack-plugin-walkthrough.md        # Complete 6-file Rust + frontend plugin walkthrough
```
