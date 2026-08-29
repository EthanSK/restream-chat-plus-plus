import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('updater architecture regression guard', () => {
  const updaterPath = path.resolve(__dirname, '../main/updater.ts');
  const controllerPath = path.resolve(__dirname, '../main/update-controller.ts');
  const updater = fs.readFileSync(updaterPath, 'utf8');
  const controller = fs.readFileSync(controllerPath, 'utf8');

  it('has one native download entry point and no hidden background download', () => {
    expect(updater.match(/autoUpdater\.checkForUpdates\(\)/g)).toHaveLength(1);
    expect(updater).not.toContain('SUPPRESS_FOREGROUND_DOWNLOAD_UI');
    expect(updater).not.toContain('checkForUpdatesInBackground');
    expect(updater).toContain(
      "'[updater] metadata poller armed; native download is user-initiated'",
    );
  });

  it('never force-relaunches around Squirrel installation', () => {
    expect(updater).not.toContain('app.relaunch');
    expect(updater).not.toContain('app.exit');
    expect(updater.match(/autoUpdater\.quitAndInstall\(\)/g)).toHaveLength(1);
  });

  it('publishes downloading before entering the native adapter', () => {
    const publishIndex = controller.indexOf("kind: 'downloading'");
    const nativeIndex = controller.indexOf('this.deps.startNativeDownload()');
    expect(publishIndex).toBeGreaterThan(-1);
    expect(nativeIndex).toBeGreaterThan(publishIndex);
  });
});
