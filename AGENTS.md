# Repository guidance

- Implement only the current product contract. Do not add legacy payload aliases, migrations, or parallel old/new execution paths.
- Detailed analysis uses only the scene pipeline and snake_case payload fields: `event_frames`, `state_changes`, and `relationships`.
- Start with `README.md` and search for the exact symbol with `rg`. Read only the relevant section of large files.
- Do not load `package-lock.json`, `texts/`, or `tests/fixtures/` unless the task concerns dependencies or their data.
- `src/analyzer.js` is the rule/merge core; inspect it by function instead of reading the whole file.
- Shared spoiler-time logic belongs in `src/core/asof.js`; UI and MCP must call it rather than duplicate it.
- Keep MCP as a read-only adapter over `src/core/` and `src/analyzer.js`.
- Preserve public behavior with the smallest implementation and run `npm test` after changes.
