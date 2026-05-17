import React, { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  Settings,
} from '../shared/types';
import { sortVoicesByQuality, voiceQualityRank } from './tts';
import { validateIgnoreList } from './message-filters';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  voices: SpeechSynthesisVoice[];
  /**
   * Optional preview callback — when the user picks a voice in the dropdown
   * we ask the parent's TTSEngine to play a short sample so they can hear
   * the voice before committing. Auto-cancels any prior in-flight preview.
   */
  onPreviewVoice?: (voiceURI: string | undefined) => void;
}

export function SettingsDrawer({ settings, onChange, onClose, voices: initialVoices, onPreviewVoice }: Props): React.ReactElement {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(initialVoices);

  // Voices on some browsers populate asynchronously.
  useEffect(() => {
    function refresh() {
      setVoices(window.speechSynthesis?.getVoices() ?? []);
    }
    refresh();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = refresh;
      return () => {
        window.speechSynthesis.onvoiceschanged = null;
      };
    }
  }, []);

  // Render voices grouped + sorted by quality rank — Premium/Enhanced at the
  // top, then Neural/Natural, then Siri, then Eloquence, then the long tail of
  // novelty voices (Albert, Bahh, Bells, …). Alphabetical-only ordering buried
  // the actually-good voices below the robotic ones.
  const groupedVoices = useMemo(() => {
    const sorted = sortVoicesByQuality(voices);
    const groups: { label: string; voices: SpeechSynthesisVoice[] }[] = [
      { label: 'Premium / Enhanced', voices: [] },
      { label: 'Neural / Natural', voices: [] },
      { label: 'Siri', voices: [] },
      { label: 'Eloquence', voices: [] },
      { label: 'Other', voices: [] },
    ];
    for (const v of sorted) groups[voiceQualityRank(v)].voices.push(v);
    return groups.filter((g) => g.voices.length > 0);
  }, [voices]);

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
  // Per-textarea validation memos — recompute only when the list changes.
  const ttsIgnoreErrors = useMemo(
    () => validateIgnoreList(settings.filters?.tts?.ignoreRegex ?? []),
    [settings.filters?.tts?.ignoreRegex],
  );
  const notifIgnoreErrors = useMemo(
    () => validateIgnoreList(settings.filters?.notifications?.ignoreRegex ?? []),
    [settings.filters?.notifications?.ignoreRegex],
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
              <label>Voice</label>
              <select
                value={settings.tts.voiceURI ?? ''}
                onChange={(e) => {
                  const next = e.target.value || undefined;
                  patchTts({ voiceURI: next });
                  // Preview the freshly-chosen voice so the user can hear it
                  // before committing. The engine cancels any prior preview
                  // so rapid dropdown switching doesn't queue overlaps.
                  onPreviewVoice?.(next);
                }}
              >
                <option value="">System default</option>
                {groupedVoices.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} ({v.lang})
                      </option>
                    ))}
                  </optgroup>
                ))}
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
            <div className="row">
              <label>Pitch</label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={settings.tts.pitch}
                onChange={(e) => patchTts({ pitch: Number(e.target.value) })}
                {...previewOnRelease}
              />
            </div>
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
