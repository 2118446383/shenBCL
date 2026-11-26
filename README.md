# shenBCL 0.3.7 — source for application review

shenBCL is an independent Windows desktop launcher for Minecraft: Java Edition, built with Electron, Vue and TypeScript. It is not affiliated with or endorsed by Minecraft, Mojang Studios or Microsoft. Current functions include client installation, local instance management, modpack import, logs, world backups, profile previews and supported Forge server management.

## Current Microsoft integration

- Application name: shenBCL
- Public application/client ID: 5df4a819-6add-4aba-a297-6e301deeb8a0
- Public directory/tenant ID: 51e084d1-df19-4b43-9b53-2876a45a5270
- Personal-account endpoint: consumers; scopes: XboxLive.signin offline_access.
- The earlier AppID submission was declined. This source reflects the updated build for re-review. Production account sign-in, restart recovery and gameplay require Minecraft Services approval.

Players authorize on the official Microsoft website. For each game or Forge server launch, the main process completes the Microsoft, Xbox Live, XSTS and Minecraft Services exchange and checks Java Edition entitlement and the official profile. The actual launch requires a current verified identity. There is no local username, offline gameplay or configurable AppID path. Supported Forge servers require online-mode=true.

Windows-backed encryption protects account credentials on disk. The renderer only receives public profile details and the short-lived user-facing device code. The signed-in player’s active official cape may be shown in the launcher preview. Local PNG skin imports are preview-only. Bundled Minecraft textures and icons were removed and replaced with original artwork; vanilla game files, libraries and textures are obtained from Mojang endpoints. The archive contains source and test fixtures. The Windows build contains launcher runtime files.

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

Use Node.js 22 or newer on Windows. Keep the sibling arcane-launcher/ and tests/ folders in this layout. The local development folder may have a different name; exported test source imports are normalized to this review layout.

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

Project code retains its existing UNLICENSED status; publication for review does not grant an additional open-source license. Third-party components retain their respective ownership and terms; see [component notices](arcane-launcher/THIRD_PARTY_NOTICES.md). shenBCL is an independent project and is not affiliated with or endorsed by Mojang or Microsoft.
