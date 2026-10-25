# Lorebook Vault

A SillyTavern extension that gives lorebooks (World Info) cover art and an Obsidian-style markdown editor.

## Features

### Cover art
- A cover banner at the top of the World Info editor. Use the buttons on it to set, replace, or remove the image.
- A **Lorebook gallery** (images button) that shows every lorebook as a card. Click a card to open that lorebook.
- Images are uploaded to `user/images/lorebook-covers/`. The extension settings map each lorebook name to its image.

### Markdown entries
- Every entry's content box gets **Edit / Split / Preview** modes. Double-click the preview to start editing.
- **Vault** is a full-screen editor for a whole lorebook:
  - A sidebar listing every entry, with search, plus a button to create a new entry
  - Live preview, plus Back navigation between entries
  - `[[` autocomplete for links (arrow keys and Enter/Tab)
  - A "Linked mentions" (backlinks) panel
  - Paste an image to upload it and insert `![](path)`
- Supported syntax:
  - `[[Entry]]`, `[[Entry|alias]]`. A link matches an entry's title (memo) first, then its keywords. Clicking a link to a missing entry offers to create it.
  - `![[Entry]]` embeds (transcludes) another entry's content
  - `> [!note] Title` callouts, including folding with `[!tip]-` / `[!tip]+`
  - `==highlight==`, `#tags`, `%% hidden comments %%`
  - Task lists, tables, strikethrough, and code blocks
- `{{macros}}` are highlighted as chips, colour-coded by kind: random/dice, variables, control flow, comments, values.
  - `{{random}}` / `{{pick}}` lists show each unique option once, with its weight and odds (`Human ×8 · 28.6%`). Options that differ only by spelling or case show up as separate pills, which makes typos easy to spot.
  - Nested macros, `::` and comma syntax, and escaped `\,` follow SillyTavern's parsing rules.
- XML-style tags used to wrap lore (`<character name="Aria">…</character>`):
  - A tag on its own line renders as a labelled box with its attributes shown as chips. Nested tags get their own colours, and markdown inside still renders.
  - A tag inside a sentence gets a subtle inline highlight. Self-closing tags show as a chip.
  - Unclosed or mismatched tags appear in red with a squiggle, so you can spot typos.
  - SillyTavern's legacy macros (`<USER>`, `<BOT>`, `<CHAR>`, `<GROUP>`) show as macro chips.
  - Common inline HTML (`<b>`, `<i>`, `<font>`, `<span>`, …) stays HTML. Any other tag is treated as lore structure.
  - The `</>` button (or the setting) switches between this structured view and showing the raw tags as text.
- The raw text sent to the model is unchanged: what you type is what gets injected.

## Install
In SillyTavern, open **Extensions → Install extension** and paste this repo's git URL.
You can also copy this folder into `public/scripts/extensions/third-party/`.

## Notes
- Covers are keyed by lorebook name, so renaming a lorebook loses its cover.
- When you close the Vault, it saves and reloads the built-in World Info editor so the two stay in sync.
