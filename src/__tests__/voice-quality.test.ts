import { describe, it, expect } from 'vitest';
import { sortVoicesByQuality, voiceQualityRank } from '../renderer/tts';

// Minimal stand-in shape — sortVoicesByQuality only needs `name`.
const v = (name: string) => ({ name });

describe('voiceQualityRank', () => {
  it('ranks Premium / Enhanced as 0 (top tier)', () => {
    expect(voiceQualityRank(v('Ava (Premium)'))).toBe(0);
    expect(voiceQualityRank(v('Samantha (Enhanced)'))).toBe(0);
    expect(voiceQualityRank(v('Daniel Enhanced'))).toBe(0);
  });

  it('ranks Neural / Natural as 1', () => {
    expect(voiceQualityRank(v('Google US English Neural'))).toBe(1);
    expect(voiceQualityRank(v('Microsoft Aria Natural'))).toBe(1);
  });

  it('ranks Siri as 2', () => {
    expect(voiceQualityRank(v('Siri Voice 1'))).toBe(2);
    expect(voiceQualityRank(v('siri voice 4'))).toBe(2);
  });

  it('ranks Eloquence as 3', () => {
    expect(voiceQualityRank(v('Eloquence Reed'))).toBe(3);
    expect(voiceQualityRank(v('Grandma (Eloquence)'))).toBe(3);
  });

  it('ranks plain robotic novelty voices as 4 (bottom)', () => {
    expect(voiceQualityRank(v('Albert'))).toBe(4);
    expect(voiceQualityRank(v('Bahh'))).toBe(4);
    expect(voiceQualityRank(v('Bells'))).toBe(4);
    expect(voiceQualityRank(v('Bubbles'))).toBe(4);
    expect(voiceQualityRank(v('Cellos'))).toBe(4);
    expect(voiceQualityRank(v('Trinoids'))).toBe(4);
  });
});

describe('sortVoicesByQuality', () => {
  it('puts Premium/Enhanced voices at the top, novelty voices at the bottom', () => {
    const input = [
      v('Albert'),
      v('Bahh'),
      v('Ava (Premium)'),
      v('Bells'),
      v('Samantha (Enhanced)'),
      v('Siri Voice 1'),
      v('Google US English Neural'),
      v('Eloquence Reed'),
    ];
    const out = sortVoicesByQuality(input).map((x) => x.name);
    // Tier 0 (Premium / Enhanced) — alphabetical within tier.
    expect(out[0]).toBe('Ava (Premium)');
    expect(out[1]).toBe('Samantha (Enhanced)');
    // Tier 1 (Neural / Natural)
    expect(out[2]).toBe('Google US English Neural');
    // Tier 2 (Siri)
    expect(out[3]).toBe('Siri Voice 1');
    // Tier 3 (Eloquence)
    expect(out[4]).toBe('Eloquence Reed');
    // Tier 4 (Other) — alphabetical within tier.
    expect(out.slice(5)).toEqual(['Albert', 'Bahh', 'Bells']);
  });

  it('is stable / pure — does not mutate the input array', () => {
    const input = [v('Trinoids'), v('Ava (Premium)'), v('Albert')];
    const before = input.map((x) => x.name);
    sortVoicesByQuality(input);
    expect(input.map((x) => x.name)).toEqual(before);
  });

  it('handles empty input', () => {
    expect(sortVoicesByQuality([])).toEqual([]);
  });

  it('secondary-sorts alphabetically within the same tier', () => {
    const input = [v('Zelda Enhanced'), v('Aaron Enhanced'), v('Maya Enhanced')];
    const out = sortVoicesByQuality(input).map((x) => x.name);
    expect(out).toEqual(['Aaron Enhanced', 'Maya Enhanced', 'Zelda Enhanced']);
  });
});
