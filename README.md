# Lorebook Vault

A SillyTavern extension that gives lorebooks (World Info) cover art, an Obsidian-style vault, and a rich text editor for every prompt field.

## Features

### Cover art
- A cover banner at the top of the World Info editor. Use the buttons on it to set, replace, or remove the image.
- A **Lorebook gallery** (images button) that shows every lorebook as a card. Click a card to open that lorebook.
- Images are uploaded to `user/images/lorebook-covers/`. The extension settings map each lorebook name to its image.

### Rich text editing in every prompt field
Every field whose text is sent to the model is edited in place, with its formatting shown as you type. There is no switching to a plain textarea to make a change.
- **Where:** lorebook entries; character cards (description, personality, scenario, first message, alternate greetings, example dialogue, main prompt / post-history overrides, character's note); presets (prompt manager prompts and quick edits, utility prompts, prefills, story string, instruct sequences, system prompts, reasoning formatting); persona description, Author's Note, and any other field SillyTavern marks for macros. SillyTavern's "expand the editor" popup is rich as well. Each group can be switched off in the settings.
- **Live preview editing:** `**bold**`, `*italic*`, headings, quotes, callouts, lists, `"dialogue"`, `{{macros}}`, and `<lore>` tags are styled in place. Markdown symbols are hidden on lines you aren't editing and reappear on the line with the caret, like Obsidian's Live Preview. You can turn this off.
- **Exact text:** the editor works on the plain text, so what you see is exactly what's saved and sent to the model. Nothing is converted to HTML.
- **Toolbar** (on hover/focus): bold, italic, strikethrough, heading, quote, list, inline code, wrap in `{{ }}`, plus the view switcher: **Rich**, **Plain text** (SillyTavern's original textarea, with its macro autocomplete), and **Preview** (the full render with boxes, callouts, and macro pills). Ctrl+B / Ctrl+I and undo/redo work as usual.
- In lorebook entries, `[[` autocompletes entry names, Ctrl+click follows a `[[link]]`, and the **Vault** button opens the entry in the Vault.

### Vault
A full-screen editor for a whole lorebook:
- A sidebar listing every entry, with search, plus a button to create a new entry
- The same rich editor, with an optional side-by-side preview, plus Back navigation between entries
- `[[` autocomplete for links (arrow keys and Enter/Tab)
- A "Linked mentions" (backlinks) panel
- Paste an image to upload it and insert `![](path)`

### Syntax
- Supported syntax:
  - `[[Entry]]`, `[[Entry|alias]]`. A link matches an entry's title (memo) first, then its keywords. Clicking a link to a missing entry offers to create it.
  - `![[Entry]]` embeds (transcludes) another entry's content
  - `> [!note] Title` callouts, including folding with `[!tip]-` / `[!tip]+`
  - `==highlight==`, `#tags`, `%% hidden comments %%`
  - Task lists, tables, strikethrough, and code blocks
- In previews, `{{macros}}` are highlighted as chips, colour-coded by kind: random/dice, variables, control flow, comments, values.
  - `{{random}}` / `{{pick}}` lists show each unique option once, with its weight and odds (`Human ×8 · 28.6%`). Options that differ only by spelling or case show up as separate pills, which makes typos easy to spot.
  - Nested macros, `::` and comma syntax, and escaped `\,` follow SillyTavern's parsing rules.
- XML-style tags used to wrap lore (`<character name="Aria">…</character>`):
  - A tag on its own line renders as a labelled box with its attributes shown as chips. Nested tags get their own colours, and markdown inside still renders.
  - A tag inside a sentence gets a subtle inline highlight. Self-closing tags show as a chip.
  - Unclosed or mismatched tags appear in red with a squiggle, so you can spot typos.
  - SillyTavern's legacy macros (`<USER>`, `<BOT>`, `<CHAR>`, `<GROUP>`) show as macro chips, and `<START>` in example dialogue shows as a separator.
  - Common inline HTML (`<b>`, `<i>`, `<font>`, `<span>`, …) stays HTML. Any other tag is treated as lore structure.
  - The `</>` button (or the setting) switches between this structured view and showing the raw tags as text.
- The raw text sent to the model is unchanged: what you type is what gets injected.

## Install
In SillyTavern, open **Extensions → Install extension** and paste this repo's git URL.
You can also copy this folder into `public/scripts/extensions/third-party/`.

## Notes
- Covers are keyed by lorebook name, so renaming a lorebook loses its cover.
- When you close the Vault, it saves and reloads the built-in World Info editor so the two stay in sync.
- The rich editor keeps SillyTavern's textarea in the page (hidden) and writes every edit into it, so SillyTavern's own saving, token counters, and other extensions keep working. SillyTavern's macro autocomplete popup only appears in the **Plain text** view.
