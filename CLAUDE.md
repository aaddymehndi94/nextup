# nexttupp

Personal streaming platform: search a title → see metadata → pick a torrent → stream it in the browser.
See `README.md` for how to run it and `docs/` for architecture decisions.

## Runtime

- Node 24 via nvm (`nvm use` reads `.nvmrc`). System node is 18 and too old.

## Agent skills

### Reach for a skill first

Every task starts by loading the skill that covers it:

- **UI** (any screen, component or style in `web/` or `site/`): `impeccable`. `DESIGN.md` is the design system and `.impeccable/surfaces/` holds the briefs; UI work is done when its finish review has run and `DESIGN.md` is updated.
- **Feature or bug fix**: `mattpocock-skills:tdd`.
- **Bug that survives a first look**: `mattpocock-skills:diagnosing-bugs`.
- **New term or decision**: `mattpocock-skills:domain-modeling` (`GLOSSARY.md`, `docs/adr/`).
- **Module interface or seam**: `mattpocock-skills:codebase-design`.
- **Review**: `mattpocock-skills:code-review`. **PR body**: `mattpocock-skills:pr`.
- **Throwaway experiment**: `mattpocock-skills:prototype`. **Research**: `mattpocock-skills:research`.
- **CLAUDE.md or a skill**: `mattpocock-skills:writing-for-agents`.

impeccable lives in `.claude/skills/impeccable`. The `mattpocock-skills` plugin is enabled in `.claude/settings.json`; when its skills are missing, install it with `/plugin install mattpocock-skills@claude-plugins-official`.

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
