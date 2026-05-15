import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

// macOS signing + notarization are gated on the FULL secret set being
// present in the environment. CI provides them; local `npm run make` runs
// without secrets and produces an unsigned dev build (no error).
const hasMacSigningSecrets =
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID &&
  !!process.env.APPLE_IDENTITY;

const osxSign = hasMacSigningSecrets
  ? {
      identity: process.env.APPLE_IDENTITY,
      optionsForFile: () => ({
        // Hardened runtime is required for notarization.
        hardenedRuntime: true,
        entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
        'entitlements-inherit': path.resolve(
          __dirname,
          'build/entitlements.mac.plist',
        ),
        'gatekeeper-assess': false,
        'signature-flags': 'library',
      }),
    }
  : undefined;

const osxNotarize = hasMacSigningSecrets
  ? {
      appleId: process.env.APPLE_ID!,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
      teamId: process.env.APPLE_TEAM_ID!,
    }
  : undefined;

// App icon. Forge / electron-packager auto-appends the platform-specific
// extension (.icns on macOS, .ico on Windows). For Linux, makers (`MakerDeb`,
// `MakerRpm`) consume `build/icon.png` directly via their own `options.icon`.
const iconPath = path.resolve(__dirname, 'build/icon');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Restream Chat Plus Plus',
    executableName: 'restream-chat-plus-plus',
    appBundleId: 'com.ethansk.restream-chat-plus-plus',
    appCategoryType: 'public.app-category.social-networking',
    icon: iconPath,
    // macOS is shipped as TWO separate per-arch zips (arm64 + x64) rather
    // than one universal `lipo`-merged bundle. Reasons:
    //   1. update.electronjs.org polls per-arch URLs anyway, so per-arch
    //      builds are first-class for auto-update.
    //   2. The universal stitch path on Electron 42 trips a known
    //      `_CodeSignature` mismatch (uniqueToArm64 vs x64) that requires
    //      a singleArchFiles override; not worth the fragility when CI
    //      builds both arches in parallel anyway.
    // The release workflow's matrix sets `--arch=arm64` and `--arch=x64`
    // on macos-14 (arm64 host) for each leg.
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      // Windows installer icon (shown in Add/Remove Programs + the .exe itself).
      setupIcon: path.resolve(__dirname, 'build/icon.ico'),
    }),
    // MakerZIP for darwin produces the .zip that update-electron-app +
    // update.electronjs.org expect for GitHub-releases-backed auto-updates.
    new MakerZIP({}, ['darwin']),
    new MakerRpm({
      options: {
        icon: path.resolve(__dirname, 'build/icon.png'),
      },
    }),
    new MakerDeb({
      options: {
        icon: path.resolve(__dirname, 'build/icon.png'),
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
