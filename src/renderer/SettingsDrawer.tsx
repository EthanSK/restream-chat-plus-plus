import React, { useEffect, useState } from 'react';
import {
  Platform,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  Settings,
} from '../shared/types';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  voices: SpeechSynthesisVoice[];
}

export function SettingsDrawer({ settings, onChange, onClose, voices: initialVoices }: Props): React.ReactElement {
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
              <label>Voice</label>
              <select
                value={settings.tts.voiceURI ?? ''}
                onChange={(e) => patchTts({ voiceURI: e.target.value || undefined })}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
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
