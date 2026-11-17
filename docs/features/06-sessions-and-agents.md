# Sessions and agents

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking). Implementation plan: [agent canvas plan](../plans/agent-canvas.md).

A **board session** is one board with its own address. People in browser tabs and agents that use ChalanaMaya's MCP server work on the same session at the same time. This is board-session sync, not the collaboration features listed in [out of scope](../out-of-scope.md).

## SESS-01 — Board session address

**Priority: P1**

Every board is a session whose address ends with its id: `/s/<id>`.

Acceptance criteria:
- Opening `/` starts a new empty session and moves to `/s/<id>`; the id is a random URL-safe string of 24 characters (at least 128 bits of randomness).
- Reloading or reopening `/s/<id>` shows the same board, including pictures, media, board colour and grid; theme and zoom/scroll stay personal to the browser.
- An id that does not exist shows a clear message and a **Start a new board** button; a badly formed id shows a not-found page.

## SESS-02 — New board and recent boards

**Priority: P1**

Start another board and get back to earlier ones.

Acceptance criteria:
- **New board** in the main menu opens a new session; Ctrl/⌘ + click opens it in a new tab.
- **Recent boards** lists up to 20 sessions opened in this browser with their title and last-opened time, and opens one with a click.
- A board can be given a title, shown in the menu and the browser tab title.

## SESS-03 — Copy board link and session id

**Priority: P1**

Hand a board to an agent or another tab.

Acceptance criteria:
- **Copy board link** copies the full `/s/<id>` address; **Copy session id** copies only the id; both confirm with a short notice.
- When the clipboard is refused, the link and id are shown selected so they can be copied by hand.
- Both actions remind the user that anyone with the link or id can change the board.

## SESS-04 — Live board sync

**Priority: P1**

Changes from any tab or agent on the same session show up everywhere without reloading.

Acceptance criteria:
- An item added, changed, moved, restyled, re-layered or deleted in one tab appears in other open tabs of the session within one second on a local network.
- Agent changes appear live in open tabs in the same way.
- When two edits hit the same item at the same moment, the later one is kept for that item and the board stays consistent in every tab; a change to an item that someone else deleted is not kept and a short notice explains why.
- Undo and redo only revert the changes made in this tab; other tabs' and agents' changes stay, including pictures and media they added.
- Items that others add or change while this tab is dragging, resizing, rotating or typing are still there after the drag ends, after Esc cancels it and after undo.
- A tab only sends changes it made itself: once every tab has the same board, no tab sends anything until someone edits again (no back-and-forth corrections).

## SESS-05 — Boards saved on the ChalanaMaya server

**Priority: P1**

The server keeps session boards and their files on disk.

Acceptance criteria:
- Boards survive a server restart; pictures and media are stored by the server and loaded from it.
- Saving a .chalana file still produces a self-contained file with all pictures and media inside (within the documented size limit).
- Opening a .chalana file into a session uploads its pictures and media to the server.

## SESS-06 — Import a board saved in this browser

**Priority: P1**

Bring a board from the earlier browser-only version into a session.

Acceptance criteria:
- When a board saved in this browser at the same address is found, a banner offers to import it; the main menu offers the same.
- ChalanaMaya starts at `http://localhost:5183` by default, the address the earlier version used with `npm run dev`; boards saved at `http://localhost:5184` are imported by starting once with `PORT=5184` and opening that address. The menu and setup guide explain this.
- Import brings in all items and pictures as one undo step, into an empty board or beside existing items.
- The old browser copy is kept until the user chooses **Remove the old copy**.

## SESS-07 — Connection status

**Priority: P1**

Show whether the board is saved and live.

Acceptance criteria:
- A small status shows Saved, Saving, or Offline.
- Changes made while offline are kept and sent when the connection returns, also after a reload in the same browser.
- Adding pictures or media while offline is refused with a clear notice; items already on the board keep working.
- A session that was deleted elsewhere shows a clear message instead of failing silently.

## SESS-08 — Access by link

**Priority: P1**

There are no accounts yet: the session id works like a password.

Acceptance criteria:
- Anyone or any agent with the id can read and change the board; this is explained in the Board session menu, the Connect an agent dialog and `docs/security.md`.
- The id never appears in full in server logs and is not sent to other websites (only the site origin is sent as referrer).
- The server listens only on this computer by default; docs explain how and when to expose it with HTTPS.
- No page, API, MCP tool, resource list or log lists the ids of boards.

## SESS-09 — Delete a board

**Priority: P2**

Remove a board and its files from the server.

Acceptance criteria:
- **Delete this board** asks for confirmation, then removes the board and files no other board uses.
- Open tabs of that board show that it was deleted; its address then shows the "does not exist" message.

## SESS-10 — Server storage limits

**Priority: P1**

One server cannot be filled up by people who create many boards.

Acceptance criteria:
- The server has limits for the number of boards, the total size of stored media and the database size; the defaults are documented and can be changed by the server owner.
- Going over a limit gives a clear "server is full" message (HTTP 507) and leaves existing boards readable and unchanged.
- Creating boards, uploading and agent requests are rate limited per address; limits can be changed or turned off by the server owner.

## AGENT-01 — MCP endpoint

**Priority: P1**

ChalanaMaya has a built-in MCP server over Streamable HTTP at `/mcp`.

Acceptance criteria:
- Standard MCP clients can connect, list tools, prompts and resources, and call tools.
- Every board tool takes `session_id`, accepting either the id or the full board link.
- Requests from unexpected host names are refused for the whole server, including `/mcp`, the API and live connections (DNS-rebinding protection); a configured public address is allowed.
- A request of up to 16 MB (enough for a 10 MB file in base64) is accepted.
- The endpoint keeps no per-client state, so clients keep working after a server restart.

## AGENT-02 — Desktop (stdio) entry point

**Priority: P1**

Desktop MCP clients can start ChalanaMaya's MCP server as a command.

Acceptance criteria:
- `node <path to ChalanaMaya>/dist-server/stdio.js` (also `npm run mcp:stdio`, or `chalanamaya-mcp` after `npm link`) speaks MCP over stdio and offers the same tools, prompts and resources as `/mcp`, including 10 MB uploads.
- Its changes appear live in open browser tabs, because it forwards to the running ChalanaMaya server set by `CHALANAMAYA_URL`.
- A clear error is returned when the server cannot be reached.

## AGENT-03 — Read the board

**Priority: P1**

Agents can see what is on a board in a compact form.

Acceptance criteria:
- `get_scene` returns items in layer order with only useful fields (id, type, position, size, text or label, colours by palette name, connections, group, frame).
- It can filter by ids, region or text, pages long boards, and also returns a short text outline and a suggested free spot for new items.
- `get_session_info` returns the title, link, item count and board bounds.

## AGENT-04 — Add items

**Priority: P1**

Agents can add every kind of item from a high-level description.

Acceptance criteria:
- `add_elements` adds boxes, diamonds, ovals, text, sticky notes, page frames, connectors (bound to items by id or by a key from the same call), paths, pencil strokes, pictures, web cards, GIFs, videos and animated components.
- Missing positions, sizes and styles get sensible defaults; the result lists each new id with its final position and size; text sizes match what the browser shows to within a few percent.
- Invalid input changes nothing and returns an error naming the field and the reason; unknown fields are ignored and listed as warnings.
- Write tools accept an optional `agent_name` used in the notices people see.

## AGENT-05 — Change, move and delete items

**Priority: P1**

Agents can edit what is already there.

Acceptance criteria:
- `update_elements` changes text, labels, geometry, connector ends, links and lock state; `move_elements` moves by an offset or to a position; `delete_elements` removes items (labels go with their shape, connectors are unbound).
- Bound connectors and labels follow moved items exactly as when a person moves them.
- Locked items can still be changed by agents only when the call unlocks them first; otherwise the error says the item is locked.

## AGENT-06 — Style, group, layer and arrange

**Priority: P1**

Agents can make boards tidy and readable.

Acceptance criteria:
- `set_style` applies colours, fill, stroke, roughness, edges, opacity and font settings, and reports items that do not accept a setting.
- `group_elements`, `ungroup_elements`, `reorder_elements` (front, back, forward, backward) and `arrange_elements` (align, distribute, gap) behave like the matching menu actions.
- `update_session` sets the board title, board colour and grid.

## AGENT-07 — Clear the board

**Priority: P1**

Agents can start over when asked.

Acceptance criteria:
- `clear_scene` needs `confirm: true` and removes every item.
- Open tabs show the empty board and a notice naming the agent with a **Restore** action that brings every cleared item back as one change.

## AGENT-08 — Place media

**Priority: P1**

Agents can put pictures, GIFs, videos and components on a board.

Acceptance criteria:
- `upload_media` stores bytes (base64) and returns a file id; `place_media` places a picture, GIF or video from a file id, an https link or bytes.
- Size and type limits match [MEDIA-08](07-media.md#media-08--media-limits-and-safety) and give clear errors.
- Placing media from a link returns a warning that links are shown as live items and as placeholders in exports, and that uploading gives full support.
- `list_component_presets` lists animated component presets and their settings.

## AGENT-09 — Drawing guide for agents

**Priority: P1**

Teach agents to draw well on ChalanaMaya.

Acceptance criteria:
- MCP prompts `draw_diagram`, `explain_board`, `tidy_board` and `chalanamaya_guide` are available.
- MCP resources provide the guide, the element input reference, the palette, component presets, and read-only board views per session.
- A portable skill document `skills/chalanamaya/SKILL.md` explains coordinates, layout, colours, workflow and recipes, with copy-ready examples.

## AGENT-10 — Setup guides

**Priority: P1**

Make connecting an agent easy.

Acceptance criteria:
- `docs/agents/setup.md` has tested steps for Claude Desktop, Claude Code, Devin, ChatGPT and other MCP clients (HTTP and stdio).
- It explains that cloud agents (Devin, ChatGPT) need a public HTTPS address such as a tunnel, and that the session id is then the only protection.
- `docs/agents/mcp-tools.md` documents every tool with an example; a test fails when a tool is missing from it.

## AGENT-11 — See what agents changed

**Priority: P2**

People notice agent edits.

Acceptance criteria:
- Items changed by an agent get a short highlight in open tabs.
- When the change is outside the view, a notice names the agent ("Claude added 6 items") with a **Show** action that zooms to them.

## AGENT-12 — Board preview for agents

**Priority: P2** (not scheduled in the current plan; see its open question 7)

Agents can look at a picture of the board to check their work.

Acceptance criteria:
- `get_preview` returns a PNG of the board or a region, like a PNG export without editor controls.
- Media and components appear as their export fallbacks.

## AGENT-13 — Connect an agent dialog

**Priority: P1**

Show users what to give their agent.

Acceptance criteria:
- The dialog shows the MCP address, the session id and copy buttons for ready-made setup snippets (HTTP and stdio) and a sample instruction.
- It repeats that the session id lets anyone change the board.
