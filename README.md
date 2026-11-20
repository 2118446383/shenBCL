# shenBCL 0.3.6 — source for application review

shenBCL is a Windows desktop launcher for Minecraft: Java Edition, built with Electron, Vue and TypeScript. This repository contains reviewable source, build configuration and controlled regression tests. It is a working development release; planned AI, multiplayer, map and replay tools are not implemented.

## Current Microsoft integration

- Application name: shenBCL
- Public application/client ID: 5df4a819-6add-4aba-a297-6e301deeb8a0
- Public directory/tenant ID: 51e084d1-df19-4b43-9b53-2876a45a5270
- Personal-account endpoint: consumers; scopes: XboxLive.signin offline_access.
- Microsoft device-code endpoint returned HTTP 200 for this application on 2026-11-20. Minecraft Services approval and real-account end-to-end verification are still pending. No approval is claimed.

Players authorize in the official Microsoft website. The main process exchanges Microsoft, Xbox Live, XSTS and Minecraft tokens, validates Java entitlement and profile, and retrieves skin/cape images. Tokens stay in the main process and are encrypted locally with Electron safeStorage backed by Windows. The renderer receives only public profile data and the user-facing device code. Failed Microsoft authentication is not silently changed into an offline identity. A separate local/offline mode is explicitly labeled and is not presented as a verified Microsoft account.

## Inspect the implementation

- [Application identity](arcane-launcher/src/shared/microsoft-app.ts)
- [Authentication, ownership and profile service](arcane-launcher/src/main/services/account.ts)
- [Encrypted storage, IPC and trusted-window boundary](arcane-launcher/src/main/main.ts)
- [Renderer bridge](arcane-launcher/src/main/preload.ts)
- [Account interface](arcane-launcher/src/renderer/components/AccountDialog.vue)
- [Authenticated game launch](arcane-launcher/src/main/services/launch.ts)
- [Security review and remaining limits](arcane-launcher/docs/SECURITY_REVIEW.md)
- [Authentication regression tests](tests/account.test.ts)

## Build and test

Use Node.js 22 or newer on Windows. Keep the sibling arcane-launcher/ and tests/ folders in this layout.

```powershell
cd arcane-launcher
npm ci
npm run build
npm test
npm start
# Optional Windows distribution:
npm run package:dir
node scripts/verify-package.mjs
```

The test runner reads ../tests and places temporary fixtures under ../tests/.tmp. The application distribution contains no tests or npm dependency tree. Network access is required to install development dependencies, download Electron and use game services. Java is a separate prerequisite for launching Minecraft; the project does not include game files, Java, mods or modpacks.

## Included and excluded

This archive contains source, icons/textures, build configuration, licenses, selected technical documentation and test sources. It excludes node_modules, dist, releases, caches, local verification data, account files, tokens, player instances, saves, game archives and machine-specific cleanup reports. SOURCE_MANIFEST.sha256 records the included file bytes.

Project code retains its existing UNLICENSED status; publication for review does not grant an additional open-source license. Third-party code and Minecraft textures retain their respective ownership and terms; see [component notices](arcane-launcher/THIRD_PARTY_NOTICES.md). shenBCL is an independent project and is not affiliated with or endorsed by Mojang or Microsoft.
