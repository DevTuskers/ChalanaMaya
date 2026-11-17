# Media

Status: MEDIA-01, MEDIA-02, MEDIA-04, MEDIA-07, MEDIA-08, MEDIA-09 and MEDIA-10 are done (agent canvas phase 5, round 1); MEDIA-03 is done except the play badge on paused items (see its note); MEDIA-05 and MEDIA-06 are done (agent canvas phase 6, round 2). Priorities follow the [tracking guide](../README.md#feature-tracking). Implementation plan: [agent canvas plan](../plans/agent-canvas.md).

Moving content on the board: animated GIFs, videos and animated CSS components. They are normal board items: they can be moved, resized, rotated, selected, grouped, layered, locked, undone and redone, and they sync to every tab and agent on the session.

## MEDIA-01 — Animated GIFs

**Priority: P1**

Show GIFs with their animation.

Acceptance criteria:
- A GIF placed on the board animates at its own frame timing and can be paused and played again.
- It can be moved, resized (Shift keeps its shape), rotated, cropped, flipped, grouped, layered, locked, undone and redone like a picture.
- A very large GIF shows its first frame and a notice instead of slowing the board down.
- A GIF from a link also animates, even when the other site does not allow downloads by script; it is shown as a live item ([MEDIA-04](#media-04--add-media-from-a-file-or-a-link)).

## MEDIA-02 — Videos

**Priority: P1**

Play MP4 and WebM videos on the board.

Acceptance criteria:
- A video starts muted and looping; an uploaded video is drawn in its place in the layer order (items above it cover it).
- It can be moved, resized, rotated, grouped, layered, locked, undone and redone; videos outside the view pause and are not loaded until they come into view.
- A video from a link plays even when the other site does not allow downloads by script.
- A video that cannot be played shows a clear card with its name instead of disappearing.

## MEDIA-03 — Playback controls

**Priority: P1**

Control how media plays.

Acceptance criteria:
- The properties panel offers Play/Pause, Mute/Unmute, Loop and Restart for videos, and Play/Pause for GIFs and components; a play badge on a paused item also starts it.
- Sound plays only after the user turns it on, and only in that tab: other tabs and people stay muted.
- Play/pause, loop and autoplay are saved with the board and synced; mute is personal to each tab.

Status (phase 5, round 1): the properties panel controls, per-tab mute and synced pause/loop/autoplay are done. Not yet: the play badge on a paused item that starts it when clicked (use the panel's Play).

## MEDIA-04 — Add media from a file or a link

**Priority: P1**

Put media on the board in familiar ways.

Acceptance criteria:
- **Insert media…** in the main menu accepts a file or an https link; dropping or pasting a GIF, MP4 or WebM file also works.
- Uploaded files are stored by the ChalanaMaya server and drawn in the board, in layer order; links (pictures, GIFs and videos alike) are loaded by the browser without sending the board address, are never fetched by the server, and are shown as live items above drawn items (like web cards), with a note that uploading gives full support.
- The colour picker (eyedropper) keeps working with any media on the board.
- Agents can do the same through MCP ([AGENT-08](06-sessions-and-agents.md#agent-08--place-media)).

Status (phase 5, round 1): files come from **Insert picture or video…**, paste or drop; links from **Add media link…** (with a type picker for addresses without a file extension). The link dialog explains that links are live only and that uploading gives full support.

## MEDIA-05 — Animated component presets

**Priority: P1**

Ready-made animated pieces for explanations and mock-ups.

Acceptance criteria:
- Presets include at least a pulse dot, spinner, typing dots, progress bar, shimmer card, moving text, bouncing arrow and colour wave, each with simple settings (colour, text, speed or value).
- Presets can be added from the UI and by agents and behave like other board items.

Status (phase 6, round 2): done. **Add animated component…** in the main menu opens a dialog with the eight presets (pulse, spinner, typing-dots, progress-bar, shimmer-card, marquee, bounce-arrow, gradient-wave), their settings and a live preview; agents use `add_elements` `{type: "component", preset, params}` and `list_component_presets`. Settings are checked by type and range (colours are hex only) and text is escaped. Components show live in the same HTML layer as linked media (at most 24 live items; the selection frame and handles draw above them, and the frame ignores the pointer, so the board moves, resizes and rotates it), and as a still card on the canvas otherwise: a simple picture of the preset (dot and ring, ring, three dots, filled bar, card lines, the text, the arrow, the colour gradient) with the title. Frames stay see-through in the dark theme, and preset text and palette colours switch to their dark variants. Pause is shared with every tab. Evidence: `src/media/componentDoc.test.ts`, `src/render/media.test.ts`, `server/mcp/http.test.ts`, `e2e/components.spec.ts`.

## MEDIA-06 — Custom animated components

**Priority: P1**

Make an animated piece from your own HTML and CSS, safely.

Acceptance criteria:
- A dialog accepts HTML and CSS (each up to 20 KB) with a live preview and lists the rules.
- Content never runs scripts: components are shown in a sandboxed frame without script permission, inside a fixed page that starts with a strict content policy, after cleaning the HTML and the CSS separately; forbidden content (scripts, event attributes, `javascript:` links, `@import`, outside `url()` resources, frames, forms, meta tags) is refused with a message naming the rule.
- Components cannot load anything from the internet, open windows or change the board.

Status (phase 6, round 2): done. The dialog's **Custom HTML and CSS** mode takes HTML and CSS (20 KB each, counted as UTF-8 bytes), lists the rules and shows a live preview; agents send `html`, `css` and `title`. Content is checked when it is added, opened from a `.chalana` file and stored on the server (`src/shared/components.ts`); unsafe content is refused with the rule name (`unsafe_component` for agents). The frame has `sandbox=""` (no scripts, no same origin), `referrerpolicy="no-referrer"`, and its page starts with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` as the first element in `<head>`; HTML is cleaned with DOMPurify (an allow-list of layout, text and SVG shape tags) and CSS is filtered separately (no `@import`, no non-`data:` `url()`, no `expression`, `behavior`, `-moz-binding`, `image-set` or absolute addresses, and `<` escaped so it cannot close the style tag). Animate with CSS `@keyframes` or transitions: SVG `<animate>`, `<animateTransform>`, `<animateMotion>` and `<set>` are refused (`no_svg_animation`) and stripped by the sanitiser, because they would keep moving while the component is paused or under reduced motion. A `.chalana` file holding an unsafe component opens without that item and says so. Evidence: the attack corpus in `src/media/componentDoc.test.ts` and `e2e/components.spec.ts` (refused by the dialog and MCP; even unsanitised inside the sandbox and CSP it neither runs nor makes a request).

## MEDIA-07 — Media in exports and files

**Priority: P1**

Exports and files stay useful with moving content.

Acceptance criteria:
- PNG export shows a GIF's first frame, a video's poster frame with a play badge, and a still card for components; SVG export keeps the GIF animated and uses the same still fallbacks for the rest.
- A saved .chalana file contains the media and reopens with it (very large boards may keep videos as links, with a warning).
- Media from links (pictures, GIFs and videos) is shown in PNG exports as a placeholder card with the site name, and never makes an export fail.

Status (phase 5, round 1; components phase 6): done, with the `.chalana` format at version 2 (components keep their source, title and pause state; unsafe component content in a file is refused) (playback fields and links stored as links; version 1 files still open). Not yet: keeping videos of very large boards as links with a warning (every uploaded file is inlined when saving).

## MEDIA-08 — Media limits and safety

**Priority: P1**

Keep boards fast and safe.

Acceptance criteria:
- Allowed uploads are PNG, JPEG, GIF, WebP, MP4 and WebM; the file content must match its type; SVG uploads are refused.
- Limits: 10 MB per picture or GIF, 25 MB per video, 200 MB of media per board, and a total for the whole server ([SESS-10](06-sessions-and-agents.md#sess-10--server-storage-limits)); going over gives a clear message and leaves the board unchanged.
- Links must be https and may not point to IP addresses, `localhost`, single-word host names or private names such as `.local`, `.internal`, `.lan` and `.home.arpa`. These rules are a best-effort guard, not a network wall: a public name can still lead to a private address. The server itself never downloads links; `docs/security.md` explains this.
- A linked picture never breaks PNG export or the colour picker; until linked media is shown as a live item, links are refused.
- A board item can only use files uploaded to the same board.

## MEDIA-09 — Reduced motion

**Priority: P2**

Respect users who ask for less movement.

Acceptance criteria:
- With the system "reduce motion" setting, GIFs, videos and components start paused and can be played by hand.
- Turning the setting off returns to normal playback without reloading.

## MEDIA-10 — Smooth boards with moving content

**Priority: P1**

Many moving items do not make the board slow.

Acceptance criteria:
- A board with 2,000 shapes, 4 GIFs and 3 videos in view stays smooth: drawing a moving frame takes under 16 ms on average, or the board lowers the animation rate by itself.
- Dragging an item while the media plays stays responsive: no browser task longer than 50 ms during a one-second drag, and the item ends under the pointer.
- When the device is too slow even at the lower rate, moving media pauses with a notice and a **Play** action.
- At most 24 live items (components, web cards, linked media) are shown live at once; others, very small ones and all of them when zoomed far out show their still picture.
- Selected live items show their selection frame and handles above them.
