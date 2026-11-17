# Out of scope for now

These items are not planned in the current scope, including after the MVP unless the owner changes this document:

- Real-time collaboration features: user accounts and sign-in, per-person permissions or roles, live cursors and presence of other people, comments, merging of simultaneous edits inside one item, a hosted sharing service, and end-to-end encryption for shared boards.
- Shape libraries, library browsing, and reusable library publishing.
- AI or smart generation built into ChalanaMaya: text-to-diagram, Mermaid import, and wireframe-to-code.
- App-level extras: PWA or offline installation, internationalisation (i18n), and watermarks.

In scope and not to be confused with the items above:

- **Board-session sync** ([SESS-04](features/06-sessions-and-agents.md#sess-04--live-board-sync)): one board session at `/s/<id>`, stored by the ChalanaMaya server in this repo (one process, SQLite on disk), stays in sync live between several browser tabs and MCP agents that edit that same session through that server. The unguessable session id is the only access control; each item keeps its latest change (no merging inside one item); undo is per tab. There are no accounts, sign-in, cursors, presence lists, comments, permissions, hosted service or encryption; those stay out of scope as listed above.
- **External agents drawing through MCP** ([AGENT-01](features/06-sessions-and-agents.md#agent-01--mcp-endpoint) onwards): agents such as Claude, Devin or ChatGPT may draw on a session through ChalanaMaya's MCP tools. ChalanaMaya itself contains no AI model and does no generation.
- Local file export is not a hosted sharing service. A basic sketch-to-shape tool is included in the drawing specification; it does not imply a wider AI offering.
