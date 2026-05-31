import React, { useMemo } from 'react';
import {
  NativeVoiceWire,
  Platform,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  Settings,
} from '../shared/types';
import { sortVoicesByQuality, voiceQualityRank } from './tts';
import { removeHiddenUser, validateIgnoreList } from './message-filters';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  /**
   * v0.1.81 — the NATIVE OS voice list (macOS `say` / Windows System.Speech /
   * Linux spd-say|espeak), fetched from the main process by App.tsx. The
   * renderer Web-Speech voice list (`SpeechSynthesisVoice[]`) was removed with
   * the browser engine. `undefined` = still loading (dropdown shows "Loading…");
   * `[]` = none available / probe failed (dropdown shows just "System default").
   */
  nativeVoices?: NativeVoiceWire[] | undefined;
  /**
   * Preview callback — when the user picks a voice (or releases a rate/volume
   * slider) we ask main to speak a short sample through the native OS engine so
   * they can hear it before committing. Auto-cancels any prior in-flight
   * preview (handled in the main-process engine). v0.1.81: this is an IPC call
   * (`rcpp.ttsNative.preview`), not a renderer Web-Speech call.
   */
  onPreviewVoice?: (voiceURI: string | undefined) => void;
}

export function SettingsDrawer({
  settings,
  onChange,
  onClose,
  nativeVoices,
  onPreviewVoice,
}: Props): React.ReactElement {
  // v0.1.81 — render the native voice list grouped + sorted by inferred quality
  // (Premium/Enhanced first, then Neural/Natural, Siri, Eloquence, then the long
  // tail). `voiceQualityRank`/`sortVoicesByQuality` only read `.name`, so they
  // work directly on the `NativeVoiceWire` shape. `nativeVoices === undefined`
  // means "still loading"; we render a disabled "Loading…" option for that.
  const groupedVoices = useMemo(() => {
    if (!nativeVoices) return [];
    const sorted = sortVoicesByQuality(nativeVoices);
    const groups: { label: string; voices: NativeVoiceWire[] }[] = [
      { label: 'Premium / Enhanced', voices: [] },
      { label: 'Neural / Natural', voices: [] },
      { label: 'Siri', voices: [] },
      { label: 'Eloquence', voices: [] },
      { label: 'Other', voices: [] },
    ];
    for (const v of sorted) groups[voiceQualityRank(v)].voices.push(v);
    return groups.filter((g) => g.voices.length > 0);
  }, [nativeVoices]);

  function patchTts(patch: Partial<Settings['tts']>) {
    onChange({ ...settings, tts: { ...settings.tts, ...patch } });
  }

  // Shared "preview on release" wiring for the Rate / Pitch / Volume sliders.
  // Firing previewVoice on every onChange tick would queue overlapping previews
  // mid-drag; instead we wait for pointer/mouse/touch release (or arrow-key
  // release for a11y) and replay the sample once at the final value. The TTS
  // engine reads rate/pitch/volume from its own settings — which updateSettings()
  // has already propagated by the time the release handler runs — so we just
  // re-preview the current voice. Established v0.1.11 for Volume; v0.1.27
  // extended to Rate + Pitch so all 4 TTS controls preview consistently.
  const NAV_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]);
  const previewOnRelease = {
    onPointerUp: () => onPreviewVoice?.(settings.tts.voiceURI),
    onMouseUp: () => onPreviewVoice?.(settings.tts.voiceURI),
    onTouchEnd: () => onPreviewVoice?.(settings.tts.voiceURI),
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (NAV_KEYS.has(e.key)) {
        onPreviewVoice?.(settings.tts.voiceURI);
      }
    },
  };

  function patchNotif(patch: Partial<Settings['notifications']>) {
    onChange({ ...settings, notifications: { ...settings.notifications, ...patch } });
  }
  function patchUpdate(patch: Partial<Settings['update']>) {
    onChange({ ...settings, update: { ...settings.update, ...patch } });
  }

  // v0.1.26 — regex-ignore textareas. The textarea binds to a string-array
  // surface (one regex per line). Splitting on "\n" is intentional: blank
  // mid-edit lines produce empty strings which the filter helpers already
  // treat as no-op, so the user can press Enter freely.
  function patchTtsFilter(lines: string[]) {
    onChange({
      ...settings,
      filters: {
        ...settings.filters,
        tts: { ...settings.filters.tts, ignoreRegex: lines },
      },
    });
  }
  function patchNotifFilter(lines: string[]) {
    onChange({
      ...settings,
      filters: {
        ...settings.filters,
        notifications: { ...settings.filters.notifications, ignoreRegex: lines },
      },
    });
  }
  // v0.1.72 — username-axis patch helpers. Symmetric with the content-axis
  // textareas above. Empty strings (blank lines) survive the round-trip so
  // mid-edit blanks don't snap-disappear under the user's cursor.
  function patchTtsUsernameFilter(lines: string[]) {
    onChange({
      ...settings,
      filters: {
        ...settings.filters,
        tts: { ...settings.filters.tts, ignoreUsernameRegex: lines },
      },
    });
  }
  function patchNotifUsernameFilter(lines: string[]) {
    onChange({
      ...settings,
      filters: {
        ...settings.filters,
        notifications: {
          ...settings.filters.notifications,
          ignoreUsernameRegex: lines,
        },
      },
    });
  }
  // v0.1.72 — Unhide handler. Calls the pure reducer + persists; uses
  // the same `onChange` IPC path as every other settings patch so the
  // main process broadcasts SETTINGS_PUSH and ChatFeed re-renders
  // with the user's messages visible again on the next tick.
  function unhideUser(username: string) {
    onChange({
      ...settings,
      hiddenUsers: removeHiddenUser(settings.hiddenUsers ?? [], username),
    });
  }
  // Per-textarea validation memos — recompute only when the list changes.
  const ttsIgnoreErrors = useMemo(
    () => validateIgnoreList(settings.filters?.tts?.ignoreRegex ?? []),
    [settings.filters?.tts?.ignoreRegex],
  );
  const notifIgnoreErrors = useMemo(
    () => validateIgnoreList(settings.filters?.notifications?.ignoreRegex ?? []),
    [settings.filters?.notifications?.ignoreRegex],
  );
  // v0.1.72 — username-axis validation memos.
  const ttsUsernameIgnoreErrors = useMemo(
    () => validateIgnoreList(settings.filters?.tts?.ignoreUsernameRegex ?? []),
    [settings.filters?.tts?.ignoreUsernameRegex],
  );
  const notifUsernameIgnoreErrors = useMemo(
    () =>
      validateIgnoreList(
        settings.filters?.notifications?.ignoreUsernameRegex ?? [],
      ),
    [settings.filters?.notifications?.ignoreUsernameRegex],
  );

  function togglePlatform(p: Platform) {
    onChange({
      ...settings,
      filter: {
        ...settings.filter,
        platforms: { ...settings.filter.platforms, [p]: !settings.filter.platforms[p] },
      },
    });
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
        <div className="drawer-body">
          <section className="section">
            <h3>Text-to-Speech</h3>
            <div className="row">
              <label>Enabled</label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.tts.enabled}
                onChange={(e) => patchTts({ enabled: e.target.checked })}
              />
            </div>
            {/*
             * v0.1.77 (Ethan voice 4438, 2026-05-30) — Muted toggle, in sync
             * with the header 🔊/🔇 button. Both write the SAME
             * `settings.tts.muted` field (header via App.tsx toggleMuted, here
             * via patchTts), so flipping one is instantly reflected in the
             * other — there's only one source of truth. Distinct from "Enabled"
             * above: "Enabled" is the feature switch (off = TTS configured off);
             * "Muted" is a temporary silence that preserves all other TTS
             * config so un-muting restores everything. Speech happens only when
             * Enabled AND NOT Muted (the main-process dispatcher gates on both).
             */}
            <div className="row">
              <label
                title="One-click silence for spoken chat. Leaves your voice/rate/volume config untouched — un-muting restores everything. Same toggle as the 🔊/🔇 button in the app header."
              >
                Muted
              </label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.tts.muted}
                onChange={(e) => patchTts({ muted: e.target.checked })}
              />
            </div>
            {/*
             * v0.1.79 (Ethan 2026-05-31: "did u remove it from speaking out my
             * own messages? that should be an option") — Speak my own messages.
             *
             * Writes settings.tts.speakSelf. When ON (default), the user's own
             * outgoing chat (self: true echoes) is read aloud like any other
             * message. When OFF, own messages are skipped — the v0.1.72
             * behaviour. The authoritative gate is decideTtsAction gate 2 in
             * src/shared/side-effect-decision.ts (runs in the main process).
             * `?? true` defends against an older persisted blob that predates
             * this field, so the control renders checked rather than blank
             * before loadSettings' shallow-merge injects the default.
             */}
            <div className="row">
              <label
                title="When on, the app reads YOUR own sent messages aloud too. Turn off to skip your own messages. To speak your own messages but skip specific ones (e.g. your !commands), leave this on and add a regex to the TTS filters below."
              >
                Speak my own messages
              </label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.tts.speakSelf ?? true}
                onChange={(e) => patchTts({ speakSelf: e.target.checked })}
              />
            </div>
            {/*
             * v0.1.81 — the Engine dropdown was REMOVED. Speech is always the
             * native OS system voice now (the browser Web-Speech engine was
             * deleted because Chromium silenced it when the window wasn't
             * foreground). There's nothing to pick between anymore.
             */}
            <div className="row">
              <label>Read sender's name aloud</label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.tts.readSenderName}
                onChange={(e) => patchTts({ readSenderName: e.target.checked })}
              />
            </div>
            <div className="row">
              <label
                title={
                  'The system voice used to read chat aloud. List comes from your OS (macOS Speech, Windows narrator voices, or Linux speech-dispatcher/espeak). "System default" uses the OS default voice.'
                }
              >
                Voice
              </label>
              {/*
               * v0.1.81 — single NATIVE voice dropdown (no more browser/native
               * branch). `nativeVoices === undefined` = still loading; render a
               * disabled placeholder. Otherwise show "System default" + the
               * quality-grouped OS voices. Picking one previews it via the
               * native engine in main (onPreviewVoice → IPC).
               */}
              <select
                value={settings.tts.voiceURI ?? ''}
                onChange={(e) => {
                  const next = e.target.value || undefined;
                  patchTts({ voiceURI: next });
                  // Preview the freshly-chosen voice. The main-process native
                  // engine cancels any prior preview before speaking this one,
                  // so rapid dropdown switching never piles up overlaps.
                  onPreviewVoice?.(next);
                }}
              >
                {nativeVoices === undefined ? (
                  <option value="" disabled>
                    Loading voices…
                  </option>
                ) : (
                  <>
                    <option value="">System default</option>
                    {groupedVoices.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.voices.map((v) => (
                          <option key={`${v.name}|${v.lang}`} value={v.name}>
                            {v.name}
                            {v.lang ? ` (${v.lang})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </>
                )}
              </select>
            </div>
            <div className="row">
              <label>Rate</label>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={settings.tts.rate}
                onChange={(e) => patchTts({ rate: Number(e.target.value) })}
                {...previewOnRelease}
              />
            </div>
            {/*
             * v0.1.81 — the Pitch slider was REMOVED. The native OS voice
             * engines (say / Windows System.Speech / spd-say / espeak) don't
             * expose a per-utterance pitch knob we can rely on cross-platform,
             * so pitch no longer has any audible effect. The `tts.pitch` setting
             * is retained in the persisted blob for back-compat (+ the
             * `set_tts_pitch` MCP tool) but there's no UI for it anymore.
             */}
            <div className="row">
              <label>Volume</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={settings.tts.volume}
                onChange={(e) => patchTts({ volume: Number(e.target.value) })}
                {...previewOnRelease}
              />
            </div>
            <div className="row">
              <label>Max per minute</label>
              <input
                type="number"
                min="1"
                max="120"
                value={settings.tts.maxPerMinute}
                onChange={(e) => patchTts({ maxPerMinute: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
          </section>

          <section className="section">
            <h3>Notifications</h3>
            <div className="row">
              <label>Enabled</label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.notifications.enabled}
                onChange={(e) => patchNotif({ enabled: e.target.checked })}
              />
            </div>
            <div className="row">
              <label>Play sound</label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.notifications.soundEnabled}
                onChange={(e) => patchNotif({ soundEnabled: e.target.checked })}
              />
            </div>
            <div className="row">
              <label>Max per minute</label>
              <input
                type="number"
                min="1"
                max="120"
                value={settings.notifications.maxPerMinute}
                onChange={(e) => patchNotif({ maxPerMinute: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
          </section>

          <section className="section">
            <h3>Filters</h3>
            <p className="section-hint">
              One JavaScript regex per line. Matches are{' '}
              <strong>case-insensitive</strong> and tested against the message
              body. Empty lines are ignored; invalid patterns are skipped.
            </p>
            <div className="filter-row">
              <label htmlFor="tts-ignore-regex">
                Ignore TTS for messages matching:
              </label>
              <textarea
                id="tts-ignore-regex"
                className={`filter-regex${
                  ttsIgnoreErrors.length > 0 ? ' invalid' : ''
                }`}
                rows={4}
                spellCheck={false}
                placeholder={'e.g. ^!\\s*\\w+\nbot$\n\\bspam\\b'}
                value={(settings.filters?.tts?.ignoreRegex ?? []).join('\n')}
                onChange={(e) => patchTtsFilter(e.target.value.split('\n'))}
                title={
                  ttsIgnoreErrors.length > 0
                    ? ttsIgnoreErrors
                        .map((er) => `Line ${er.line}: ${er.error}`)
                        .join('\n')
                    : 'TTS will skip any message whose body matches one of these regexes.'
                }
                aria-invalid={ttsIgnoreErrors.length > 0}
              />
            </div>
            <div className="filter-row">
              <label htmlFor="notif-ignore-regex">
                Ignore notifications for messages matching:
              </label>
              <textarea
                id="notif-ignore-regex"
                className={`filter-regex${
                  notifIgnoreErrors.length > 0 ? ' invalid' : ''
                }`}
                rows={4}
                spellCheck={false}
                placeholder={'e.g. ^!\\s*\\w+\nbot$\n\\bspam\\b'}
                value={(
                  settings.filters?.notifications?.ignoreRegex ?? []
                ).join('\n')}
                onChange={(e) => patchNotifFilter(e.target.value.split('\n'))}
                title={
                  notifIgnoreErrors.length > 0
                    ? notifIgnoreErrors
                        .map((er) => `Line ${er.line}: ${er.error}`)
                        .join('\n')
                    : 'Native notifications will be suppressed for any message whose body matches one of these regexes.'
                }
                aria-invalid={notifIgnoreErrors.length > 0}
              />
            </div>
            {/*
              v0.1.72 (voice 4352, 2026-05-28) — username-axis regex textareas.
              These match against `ChatMessage.username` (the author's
              display name), independent of the content lists above. Within
              a single side-effect (TTS or notifications), the content and
              username axes OR-compose — if EITHER matches, the side effect
              is suppressed. See applyMessageFilters() in message-filters.ts
              for the contract.

              Empty by default; users opt in by typing one regex per line.
              The hover-row "Hide user" affordance writes EXACT usernames
              into the separate `settings.hiddenUsers` list (Hidden Users
              section below) — NOT into these regex textareas — because
              hide-from-hover is an exact-match one-click action, whereas
              these textareas exist for pattern-matching ("anyone whose
              name starts with 'bot_'").
            */}
            <p className="section-hint" style={{ marginTop: 18 }}>
              Username regexes — one per line. Matched case-insensitively
              against the sender&apos;s display name. Independent from the
              message-body regexes above.
            </p>
            <div className="filter-row">
              <label htmlFor="tts-ignore-username-regex">
                Ignore TTS for usernames matching:
              </label>
              <textarea
                id="tts-ignore-username-regex"
                className={`filter-regex${
                  ttsUsernameIgnoreErrors.length > 0 ? ' invalid' : ''
                }`}
                rows={3}
                spellCheck={false}
                placeholder={'e.g. ^bot_\nstreamlabs$\nnightbot'}
                value={(
                  settings.filters?.tts?.ignoreUsernameRegex ?? []
                ).join('\n')}
                onChange={(e) =>
                  patchTtsUsernameFilter(e.target.value.split('\n'))
                }
                title={
                  ttsUsernameIgnoreErrors.length > 0
                    ? ttsUsernameIgnoreErrors
                        .map((er) => `Line ${er.line}: ${er.error}`)
                        .join('\n')
                    : 'TTS will skip any message whose USERNAME matches one of these regexes.'
                }
                aria-invalid={ttsUsernameIgnoreErrors.length > 0}
              />
            </div>
            <div className="filter-row">
              <label htmlFor="notif-ignore-username-regex">
                Ignore notifications for usernames matching:
              </label>
              <textarea
                id="notif-ignore-username-regex"
                className={`filter-regex${
                  notifUsernameIgnoreErrors.length > 0 ? ' invalid' : ''
                }`}
                rows={3}
                spellCheck={false}
                placeholder={'e.g. ^bot_\nstreamlabs$\nnightbot'}
                value={(
                  settings.filters?.notifications?.ignoreUsernameRegex ?? []
                ).join('\n')}
                onChange={(e) =>
                  patchNotifUsernameFilter(e.target.value.split('\n'))
                }
                title={
                  notifUsernameIgnoreErrors.length > 0
                    ? notifUsernameIgnoreErrors
                        .map((er) => `Line ${er.line}: ${er.error}`)
                        .join('\n')
                    : 'Native notifications will be suppressed for any message whose USERNAME matches one of these regexes.'
                }
                aria-invalid={notifUsernameIgnoreErrors.length > 0}
              />
            </div>
          </section>

          {/*
            v0.1.72 (voice 4352, 2026-05-28) — Hidden Users section.
            Populated by the per-row hover "Hide user" affordance in
            ChatFeed; each entry can be Unhidden one-at-a-time here.

            Hidden users are filtered from the visible feed entirely AND
            their messages don't wake TTS / notifications either. This is
            stronger than the regex lists above (which only suppress the
            side effect — the message still renders with a "regex-ignored"
            badge). "Hide" means "as if they never spoke".

            Empty-state copy explains where entries come from so a user
            who hasn't clicked Hide on any row understands what this is.
          */}
          <section className="section">
            <h3>Hidden Users</h3>
            <p className="section-hint">
              Click <strong>Hide user</strong> on any chat row to add them
              here. Their messages disappear from the feed and never trigger
              TTS or notifications. Case-insensitive exact-match.
            </p>
            {(settings.hiddenUsers ?? []).length === 0 ? (
              <p className="hidden-users-empty">No hidden users yet.</p>
            ) : (
              <ul className="hidden-users-list">
                {(settings.hiddenUsers ?? []).map((u) => (
                  <li key={u}>
                    <span className="hidden-user-name">{u}</span>
                    <button
                      type="button"
                      className="unhide-btn"
                      title={`Unhide ${u}`}
                      aria-label={`Unhide ${u}`}
                      onClick={() => unhideUser(u)}
                    >
                      Unhide
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <h3>Updates</h3>
            <div className="row">
              <label>Auto-check for updates</label>
              <input
                className="switch"
                type="checkbox"
                checked={settings.update.autoCheck}
                onChange={(e) => patchUpdate({ autoCheck: e.target.checked })}
              />
            </div>
          </section>

          <section className="section">
            <h3>Platforms</h3>
            <div className="platform-grid">
              {(Object.keys(settings.filter.platforms) as Platform[]).map((p) => {
                const on = settings.filter.platforms[p];
                return (
                  <div
                    key={p}
                    className={`platform-chip ${on ? '' : 'off'}`}
                    onClick={() => togglePlatform(p)}
                  >
                    <span className="dot" style={{ background: PLATFORM_COLORS[p] }} />
                    {PLATFORM_LABELS[p]}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
