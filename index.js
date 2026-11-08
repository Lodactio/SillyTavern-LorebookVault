import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import {
    world_names,
    loadWorldInfo,
    saveWorldInfo,
    reloadEditor,
    createWorldInfoEntry,
    setWIOriginalDataValue,
} from '../../../world-info.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../popup.js';
import { saveBase64AsFile, getBase64Async, debounce } from '../../../utils.js';
import { renderOptions, escapeHtml, entryTitle, findEntry, backlinksFor } from './src/render.js';
import { RichField, fields } from './src/field.js';

const MODULE = 'lorebook_vault';
const COVER_FOLDER = 'lorebook-covers';

const defaultSettings = {
    coversEnabled: true,
    markdownEnabled: true, // rich editor in lorebook entries
    editorMode: 'rich', // rich | source | preview
    conceal: true, // hide markdown symbols on lines that aren't being edited
    targets: {
        character: true,
        presets: true,
        other: true,
    },
    bannerHeight: 160,
    xmlMode: 'structured', // structured | raw
    covers: {}, // lorebook name -> image path
};

/** @returns {typeof defaultSettings} */
function settings() {
    extension_settings[MODULE] = Object.assign({}, structuredClone(defaultSettings), extension_settings[MODULE]);
    const s = extension_settings[MODULE];
    s.covers ??= {};
    s.targets = Object.assign({}, defaultSettings.targets, s.targets);
    // Older versions had edit / split / preview with a click-through to a plain textarea
    if ('defaultMode' in s) {
        s.editorMode = s.defaultMode === 'edit' ? 'source' : 'rich';
        delete s.defaultMode;
    }
    renderOptions.xmlMode = s.xmlMode;
    return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentWorldName() {
    const index = Number($('#world_editor_select').val());
    return Number.isInteger(index) && index >= 0 ? world_names[index] : null;
}

// ---------------------------------------------------------------------------
// Rich editor in every prompt field
// ---------------------------------------------------------------------------

/** Prompt fields grouped by where they live. Anything else marked `data-macros` counts as "other". */
const FIELD_GROUPS = {
    character: [
        '#description_textarea',
        '#personality_textarea',
        '#scenario_pole',
        '#firstmessage_textarea',
        '#mes_example_textarea',
        '#system_prompt_textarea',
        '#post_history_instructions_textarea',
        '#depth_prompt_prompt',
        'textarea.alternate_greeting_text',
    ],
    presets: [
        // Chat Completion: prompt manager and utility prompts
        '#completion_prompt_manager_popup_entry_form_prompt',
        'textarea[id$="_prompt_quick_edit_textarea"]',
        '#impersonation_prompt_textarea',
        '#wi_format_textarea',
        '#scenario_format_textarea',
        '#personality_format_textarea',
        '#group_nudge_prompt_textarea',
        '#newchat_prompt_textarea',
        '#newgroupchat_prompt_textarea',
        '#newexamplechat_prompt_textarea',
        '#continue_nudge_prompt_textarea',
        '#send_if_empty_textarea',
        '#claude_assistant_prefill',
        '#claude_assistant_impersonation',
        '#nai_preamble_textarea',
        '#negative_prompt_textgenerationwebui',
        // Advanced Formatting: context, instruct, system prompt, reasoning
        'textarea[id^="context_"]',
        'textarea[id^="instruct_"]',
        'textarea[id^="sysprompt_"]',
        'textarea[id^="reasoning_"]',
        '#start_reply_with',
    ],
    other: [
        '#persona_description',
        '#extension_floating_prompt',
        '#extension_floating_chara',
        '#extension_floating_default',
        '#rm_group_generation_mode_join_prefix',
        '#rm_group_generation_mode_join_suffix',
        'textarea[id$="_cfg_negative_prompt"]',
        'textarea[id$="_cfg_positive_prompt"]',
        'textarea[data-macros]',
    ],
};

/** Textareas that are never prompt text, even if marked for macro autocomplete. */
const EXCLUDED = '#send_textarea, .edit_textarea, textarea[name="key"], textarea[name="keysecondary"], textarea[name="comment"], .lv-editor';

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {string|null} Settings group, or null if the field should stay a plain textarea
 */
function fieldGroup(textarea) {
    // Hidden templates SillyTavern clones from must stay untouched; their clones get enhanced instead
    if (textarea.matches(EXCLUDED) || textarea.closest('.lv-vault, .template_element, template')) return null;
    if (textarea.name === 'content' && textarea.closest('#world_popup_entries_list')) return 'lorebook';

    // SillyTavern's "expand the editor" popup: rich if the field it expands is
    if (textarea.classList.contains('maximized_textarea')) {
        const source = document.getElementById(textarea.dataset.for ?? '');
        return /** @type {any} */ (source)?.lvField ? /** @type {any} */ (source).lvField.options.group : null;
    }

    return Object.keys(FIELD_GROUPS).find(group => textarea.matches(FIELD_GROUPS[group].join(','))) ?? null;
}

function groupEnabled(group) {
    const s = settings();
    return group === 'lorebook' ? s.markdownEnabled : Boolean(s.targets[group]);
}

/** Every preview re-renders when the XML display mode changes. */
function setXmlMode(mode) {
    settings().xmlMode = mode;
    renderOptions.xmlMode = mode;
    saveSettingsDebounced();
    $('#lv_xml_mode').val(mode);
    syncXmlToggles();
    for (const field of fields) {
        if (field.isConnected) field.refreshPreview();
    }
}

function toggleXmlMode() {
    setXmlMode(settings().xmlMode === 'raw' ? 'structured' : 'raw');
}

function syncXmlToggles() {
    $('.lv-xml-toggle').toggleClass('active', settings().xmlMode === 'raw');
}

/** Options for fields inside the World Info editor: links, embeds, and the Vault button. */
function lorebookOptions(textarea) {
    let data = null;
    let dataWorld = null;
    const getData = async () => {
        const name = currentWorldName();
        if (name && (dataWorld !== name || !data)) {
            data = await loadWorldInfo(name);
            dataWorld = name;
        }
        return data;
    };
    getData();
    const uid = () => Number($(textarea).data('uid') ?? $(textarea).closest('.world_entry').attr('uid'));
    return {
        getData,
        getLinkTargets: () => (data?.entries ? Object.values(data.entries).filter(e => e.uid !== uid()).map(entryTitle) : []),
        onLinkClick: target => openVault(currentWorldName(), null, target),
        buttons: [{ icon: 'fa-book-open', title: 'Open in Vault', label: 'Vault', onClick: () => openVault(currentWorldName(), uid()) }],
    };
}

/** @param {HTMLTextAreaElement} textarea */
function enhanceField(textarea) {
    if (/** @type {any} */ (textarea).lvField) return;
    const group = fieldGroup(textarea);
    if (!group || !groupEnabled(group)) return;

    const s = settings();
    const isMaximized = textarea.classList.contains('maximized_textarea');
    const field = new RichField(textarea, {
        group,
        mode: s.editorMode,
        conceal: s.conceal,
        staticToolbar: isMaximized,
        allowSplit: isMaximized,
        onToggleXml: toggleXmlMode,
        ...(group === 'lorebook' ? lorebookOptions(textarea) : {}),
    });
    if (isMaximized) field.focus();
    syncXmlToggles();
}

let scanQueued = false;
function scanFields() {
    scanQueued = false;
    for (const field of [...fields]) {
        if (!field.options.managed && !field.isConnected) field.dispose();
    }
    document.querySelectorAll('textarea:not(.lv-source)').forEach(el => enhanceField(/** @type {HTMLTextAreaElement} */ (el)));
}

function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanFields);
}

function observeFields() {
    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const el = /** @type {Element} */ (node);
                if (el.tagName === 'TEXTAREA' || el.querySelector('textarea')) return queueScan();
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
    scanFields();
}

/** Applies changed settings to fields that are already on screen. */
function refreshFields() {
    const s = settings();
    for (const field of [...fields]) {
        if (field.options.managed) field.setConceal(s.conceal);
        else if (!groupEnabled(field.options.group)) field.destroy();
        else field.setConceal(s.conceal);
    }
    scanFields();
}

// ---------------------------------------------------------------------------
// Vault: Obsidian-style full-screen editor for a lorebook
// ---------------------------------------------------------------------------

/**
 * @param {string} worldName
 * @param {number?} uid Entry to open
 * @param {string?} target Link target to resolve and open
 */
async function openVault(worldName, uid = null, target = null) {
    if (!worldName) {
        toastr.warning('Select a lorebook first.');
        return;
    }

    const data = await loadWorldInfo(worldName);
    if (!data?.entries) {
        toastr.error('Could not load lorebook.');
        return;
    }

    let dirty = false;
    let current = null;
    const history = [];

    const root = $(`
        <div class="lv-vault">
            <aside class="lv-sidebar">
                <div class="lv-vault-header">
                    ${coverImg(worldName, 'lv-vault-cover')}
                    <div class="lv-vault-name">${escapeHtml(worldName)}</div>
                </div>
                <div class="lv-sidebar-actions">
                    <input type="search" class="text_pole lv-search" placeholder="Search entries...">
                    <div class="menu_button lv-new" title="New entry"><i class="fa-solid fa-plus"></i></div>
                </div>
                <div class="lv-file-list"></div>
            </aside>
            <section class="lv-main">
                <div class="lv-main-header">
                    <div class="menu_button lv-back" title="Back"><i class="fa-solid fa-arrow-left"></i></div>
                    <input class="text_pole lv-title" placeholder="Entry title (memo)">
                </div>
                <div class="lv-keys"></div>
                <div class="lv-editor-host">
                    <textarea class="text_pole lv-editor" spellcheck="true" placeholder="Write markdown... use [[Entry]] to link, ![[Entry]] to embed. Paste images to upload."></textarea>
                </div>
                <div class="lv-backlinks"></div>
            </section>
        </div>`);

    const fileList = root.find('.lv-file-list');
    const editor = root.find('.lv-editor');
    const titleInput = root.find('.lv-title');

    const save = debounce(() => saveWorldInfo(worldName, data), 500);

    const field = new RichField(/** @type {HTMLTextAreaElement} */ (editor[0]), {
        group: 'vault',
        managed: true,
        mode: settings().editorMode,
        conceal: settings().conceal,
        staticToolbar: true,
        allowSplit: true,
        getData: () => data,
        getLinkTargets: () => Object.values(data.entries).filter(e => e.uid !== current?.uid).map(entryTitle),
        onLinkClick: target => navigate(target),
        onToggleXml: toggleXmlMode,
        onPasteImage: async (file) => {
            try {
                const path = await uploadImage(file, `${worldName}_${Date.now()}`, 'lorebook-notes');
                return `![](${path})`;
            } catch (err) {
                console.error(err);
                toastr.error('Image upload failed.');
                return null;
            }
        },
    });

    const renderList = () => {
        const query = String(root.find('.lv-search').val() ?? '').toLowerCase();
        const entries = Object.values(data.entries)
            .filter(e => !query
                || entryTitle(e).toLowerCase().includes(query)
                || e.key?.some(k => k.toLowerCase().includes(query))
                || e.content?.toLowerCase().includes(query))
            .sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)));
        fileList.html(entries.map(e => `
            <div class="lv-file ${current?.uid === e.uid ? 'active' : ''} ${e.disable ? 'disabled' : ''}" data-uid="${e.uid}">
                <i class="fa-regular fa-file-lines"></i>
                <span>${escapeHtml(entryTitle(e))}</span>
            </div>`).join('') || '<div class="lv-empty">No entries</div>');
    };

    const renderBacklinks = () => {
        if (!current) return root.find('.lv-backlinks').empty();
        const links = backlinksFor(data, current);
        root.find('.lv-backlinks').html(`
            <div class="lv-backlinks-title">Linked mentions (${links.length})</div>
            ${links.map(e => `<a class="lv-wikilink" data-uid="${e.uid}">${escapeHtml(entryTitle(e))}</a>`).join('')}`);
    };

    const select = (entry, pushHistory = true) => {
        if (!entry) return;
        if (pushHistory && current && current.uid !== entry.uid) history.push(current.uid);
        current = entry;
        field.loadValue(entry.content ?? '');
        titleInput.val(entry.comment ?? '');
        root.find('.lv-keys').html((entry.key ?? []).map(k => `<span class="lv-key">${escapeHtml(k)}</span>`).join(''));
        root.find('.lv-back').toggleClass('disabled', history.length === 0);
        renderList();
        renderBacklinks();
    };

    const navigate = (targetName) => {
        const entry = findEntry(data, targetName);
        if (entry) return select(entry);
        callGenericPopup(`Create entry "${escapeHtml(targetName)}"?`, POPUP_TYPE.CONFIRM).then(ok => {
            if (ok) createEntry(targetName);
        });
    };

    const createEntry = (title = '') => {
        const entry = createWorldInfoEntry(worldName, data);
        if (!entry) return;
        entry.comment = title;
        if (title) entry.key = [title];
        dirty = true;
        save();
        select(entry);
        titleInput.trigger('focus');
    };

    // Events
    root.on('input', '.lv-search', renderList);
    root.on('click', '.lv-new', () => createEntry());
    root.on('click', '.lv-file', function () { select(data.entries[$(this).data('uid')]); });
    root.on('click', '.lv-back', () => {
        const uidBack = history.pop();
        if (uidBack !== undefined && data.entries[uidBack]) select(data.entries[uidBack], false);
    });
    root.on('click', '.lv-backlinks .lv-wikilink', function (e) {
        e.preventDefault();
        select(data.entries[$(this).data('uid')]);
    });

    titleInput.on('input', () => {
        if (!current) return;
        current.comment = String(titleInput.val());
        setWIOriginalDataValue(data, current.uid, 'comment', current.comment);
        dirty = true;
        save();
        renderList();
    });

    editor.on('input', () => {
        if (!current) return;
        current.content = field.getValue();
        setWIOriginalDataValue(data, current.uid, 'content', current.content);
        dirty = true;
        save();
        renderBacklinks();
    });

    renderList();
    const first = (uid !== null && data.entries[uid])
        || (target && findEntry(data, target))
        || Object.values(data.entries).sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)))[0];
    if (first) select(first, false);
    if (target && !findEntry(data, target)) navigate(target);

    syncXmlToggles();
    await callGenericPopup(root, POPUP_TYPE.DISPLAY, '', { large: true, wide: true, allowVerticalScrolling: false });
    field.destroy();

    // Flush and resync the built-in editor, which holds its own copy of the data
    if (dirty) {
        await saveWorldInfo(worldName, data, true);
        if (currentWorldName() === worldName) reloadEditor(worldName);
    }
}

// ---------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------

function coverImg(name, className) {
    const path = settings().covers[name];
    return path ? `<img class="${className}" src="${escapeHtml(path)}" alt="">` : '';
}

async function uploadImage(file, baseName, folder) {
    const dataUrl = await getBase64Async(file);
    const [header, base64] = String(dataUrl).split(',');
    const ext = header.match(/image\/(\w+)/)?.[1]?.replace('jpeg', 'jpg') ?? 'png';
    const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return saveBase64AsFile(base64, folder, safeName, ext);
}

async function deleteImage(path) {
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch (err) {
        console.warn('[Lorebook Vault] Failed to delete image', err);
    }
}

function pickImage() {
    return new Promise((resolve) => {
        const input = $('<input type="file" accept="image/*" hidden>');
        input.on('change', () => resolve(input[0].files?.[0] ?? null));
        input.trigger('click');
    });
}

async function setCover(name) {
    if (!name) return;
    const file = await pickImage();
    if (!file) return;
    try {
        const path = await uploadImage(file, `${name}_${Date.now()}`, COVER_FOLDER);
        const old = settings().covers[name];
        settings().covers[name] = path;
        saveSettingsDebounced();
        if (old) deleteImage(old);
        updateBanner();
        toastr.success('Cover art updated.');
    } catch (err) {
        console.error(err);
        toastr.error('Failed to upload cover art.');
    }
}

async function removeCover(name) {
    const old = settings().covers[name];
    if (!old) return;
    delete settings().covers[name];
    saveSettingsDebounced();
    deleteImage(old);
    updateBanner();
}

function updateBanner() {
    const banner = $('#lv_cover_banner');
    const name = currentWorldName();
    if (!settings().coversEnabled || !name) {
        banner.hide();
        return;
    }

    const path = settings().covers[name];
    banner.show()
        .toggleClass('has-cover', Boolean(path))
        .css('--lv-banner-height', `${settings().bannerHeight}px`)
        .css('background-image', path ? `url("${encodeURI(path)}")` : '');
    banner.find('.lv-banner-name').text(name);
    banner.find('.lv-banner-remove').toggle(Boolean(path));
}

function injectBanner() {
    if ($('#lv_cover_banner').length) return;
    const banner = $(`
        <div id="lv_cover_banner">
            <div class="lv-banner-name"></div>
            <div class="lv-banner-actions">
                <div class="menu_button lv-banner-set" title="Set cover art"><i class="fa-solid fa-image"></i></div>
                <div class="menu_button lv-banner-remove" title="Remove cover art"><i class="fa-solid fa-trash-can"></i></div>
                <div class="menu_button lv-banner-vault" title="Open in Vault"><i class="fa-solid fa-book-open"></i></div>
                <div class="menu_button lv-banner-gallery" title="Lorebook gallery"><i class="fa-solid fa-images"></i></div>
            </div>
        </div>`);
    banner.on('click', '.lv-banner-set', () => setCover(currentWorldName()));
    banner.on('click', '.lv-banner-remove', () => removeCover(currentWorldName()));
    banner.on('click', '.lv-banner-vault', () => openVault(currentWorldName()));
    banner.on('click', '.lv-banner-gallery', openGallery);
    $('#world_popup_entries_list').before(banner);

    const galleryButton = $('<div id="lv_gallery_button" class="menu_button fa-solid fa-images" title="Lorebook gallery"></div>');
    galleryButton.on('click', openGallery);
    $('#world_popup_delete').before(galleryButton);

    $(document).on('change', '#world_editor_select', updateBanner);
    updateBanner();
}

async function openGallery() {
    const root = $(`
        <div class="lv-gallery">
            <input type="search" class="text_pole lv-gallery-search" placeholder="Search lorebooks...">
            <div class="lv-gallery-grid"></div>
        </div>`);

    const render = () => {
        const query = String(root.find('.lv-gallery-search').val() ?? '').toLowerCase();
        const names = [...world_names].filter(n => n.toLowerCase().includes(query)).sort((a, b) => a.localeCompare(b));
        root.find('.lv-gallery-grid').html(names.map(name => `
            <div class="lv-card" data-name="${escapeHtml(name)}">
                <div class="lv-card-art">${coverImg(name, 'lv-card-img') || '<i class="fa-solid fa-book"></i>'}</div>
                <div class="lv-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="lv-card-actions">
                    <div class="menu_button lv-card-edit" title="Open in editor"><i class="fa-solid fa-pen-to-square"></i></div>
                    <div class="menu_button lv-card-vault" title="Open in Vault"><i class="fa-solid fa-book-open"></i></div>
                    <div class="menu_button lv-card-cover" title="Set cover"><i class="fa-solid fa-image"></i></div>
                </div>
            </div>`).join('') || '<div class="lv-empty">No lorebooks</div>');
    };

    const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
    root.on('input', '.lv-gallery-search', render);
    root.on('click', '.lv-card-edit, .lv-card-art', function () {
        const name = $(this).closest('.lv-card').data('name');
        $('#world_editor_select').val(world_names.indexOf(String(name))).trigger('change');
        popup.completeCancelled();
    });
    root.on('click', '.lv-card-vault', function () {
        openVault(String($(this).closest('.lv-card').data('name')));
    });
    root.on('click', '.lv-card-cover', async function () {
        await setCover(String($(this).closest('.lv-card').data('name')));
        render();
    });

    render();
    await popup.show();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function injectSettings() {
    const s = settings();
    const html = $(`
        <div class="lv-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Lorebook Vault</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input type="checkbox" id="lv_covers_enabled"> Lorebook cover art</label>
                    <h4>Rich editor in prompt fields</h4>
                    <label class="checkbox_label"><input type="checkbox" id="lv_markdown_enabled"> Lorebook entries</label>
                    <label class="checkbox_label"><input type="checkbox" class="lv-target" data-target="character"> Character card (description, personality, scenario, greetings, examples, overrides)</label>
                    <label class="checkbox_label"><input type="checkbox" class="lv-target" data-target="presets"> Presets (prompt manager, utility prompts, Advanced Formatting)</label>
                    <label class="checkbox_label"><input type="checkbox" class="lv-target" data-target="other"> Persona, Author's Note, and other macro fields</label>
                    <label class="checkbox_label"><input type="checkbox" id="lv_conceal"> Hide markdown symbols on lines you aren't editing</label>
                    <label for="lv_editor_mode">Default view</label>
                    <select id="lv_editor_mode" class="text_pole">
                        <option value="rich">Rich editor</option>
                        <option value="source">Plain text</option>
                        <option value="preview">Preview</option>
                    </select>
                    <label for="lv_xml_mode">XML tags in previews</label>
                    <select id="lv_xml_mode" class="text_pole">
                        <option value="structured">Structured (boxes)</option>
                        <option value="raw">Raw (show tags as text)</option>
                    </select>
                    <label for="lv_banner_height">Cover banner height: <span id="lv_banner_height_value"></span>px</label>
                    <input type="range" id="lv_banner_height" min="60" max="400" step="10">
                </div>
            </div>
        </div>`);

    html.find('#lv_covers_enabled').prop('checked', s.coversEnabled).on('change', function () {
        s.coversEnabled = this.checked;
        saveSettingsDebounced();
        updateBanner();
    });
    html.find('#lv_markdown_enabled').prop('checked', s.markdownEnabled).on('change', function () {
        s.markdownEnabled = this.checked;
        saveSettingsDebounced();
        refreshFields();
    });
    html.find('.lv-target').each(function () {
        const target = this.dataset.target;
        $(this).prop('checked', s.targets[target]).on('change', () => {
            s.targets[target] = this.checked;
            saveSettingsDebounced();
            refreshFields();
        });
    });
    html.find('#lv_conceal').prop('checked', s.conceal).on('change', function () {
        s.conceal = this.checked;
        saveSettingsDebounced();
        refreshFields();
    });
    html.find('#lv_editor_mode').val(s.editorMode).on('change', function () {
        s.editorMode = String($(this).val());
        saveSettingsDebounced();
        for (const field of fields) field.setMode(s.editorMode);
    });
    html.find('#lv_xml_mode').val(s.xmlMode).on('change', function () {
        setXmlMode(String($(this).val()));
    });
    html.find('#lv_banner_height_value').text(s.bannerHeight);
    html.find('#lv_banner_height').val(s.bannerHeight).on('input', function () {
        s.bannerHeight = Number($(this).val());
        html.find('#lv_banner_height_value').text(s.bannerHeight);
        saveSettingsDebounced();
        updateBanner();
    });

    $('#extensions_settings2').append(html);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(() => {
    settings();
    injectSettings();
    injectBanner();
    observeFields();

    // World list is populated asynchronously after settings load
    eventSource.on(event_types.SETTINGS_LOADED, updateBanner);
    eventSource.on(event_types.WORLDINFO_UPDATED, updateBanner);
});
