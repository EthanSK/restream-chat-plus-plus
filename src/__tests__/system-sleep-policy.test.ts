import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function productionMainSources(): Array<{ file: string; code: string }> {
  const mainDir = path.join(__dirname, '..', 'main');
  return fs
    .readdirSync(mainDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const file = path.join(mainDir, entry.name);
      return { file, code: stripComments(fs.readFileSync(file, 'utf8')) };
    });
}

describe('system sleep policy', () => {
  it('does not create a lifetime Electron power-save assertion', () => {
    for (const { file, code } of productionMainSources()) {
      expect(code, file).not.toMatch(/\bpowerSaveBlocker\b/);
      expect(code, file).not.toContain('prevent-app-suspension');
    }
  });
});
