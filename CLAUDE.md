# nextup

Personal streaming platform: search a title → see metadata → pick a torrent → stream it in the browser.
See `README.md` for how to run it and `docs/` for architecture decisions.

## Runtime

- Node 24 via nvm (`nvm use` reads `.nvmrc`). System node is 18 and too old.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
