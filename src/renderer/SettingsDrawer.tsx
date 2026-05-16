import React, { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  Settings,
} from '../shared/types';
import { sortVoicesByQuality, voiceQualityRank } from './tts';

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
  function patchNotif(patch: Partial<Settings['notifications']>) {
    onChange({ ...settings, notifications: { ...settings.notifications, ...patch } });
  }
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
                // Preview the current voice at the new volume AFTER the user
                // releases the slider (not during drag) so we don't fire a
                // preview on every micro-step. The engine reads volume from
                // its own settings, which updateSettings() has already
                // propagated by the time the release handler runs.
                onPointerUp={() => onPreviewVoice?.(settings.tts.voiceURI)}
                onMouseUp={() => onPreviewVoice?.(settings.tts.voiceURI)}
                onTouchEnd={() => onPreviewVoice?.(settings.tts.voiceURI)}
                onKeyUp={(e) => {
                  // Keyboard-driven volume changes (arrow keys, Home/End,
                  // PageUp/PageDown) should also preview on key release so
                  // a11y users get the same audible feedback.
                  if (
                    e.key === 'ArrowLeft' ||
                    e.key === 'ArrowRight' ||
                    e.key === 'ArrowUp' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'Home' ||
                    e.key === 'End' ||
                    e.key === 'PageUp' ||
                    e.key === 'PageDown'
                  ) {
                    onPreviewVoice?.(settings.tts.voiceURI);
                  }
                }}
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
