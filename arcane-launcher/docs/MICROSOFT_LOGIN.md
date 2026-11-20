# Microsoft 账号接入

已接入项目所有者注册的 shenBCL Microsoft 公共客户端应用。Minecraft API 接入申请尚待提交／审批，完整正版登录、皮肤同步和正版游戏启动仍需获准后实测，不能把代码完成视为线上认证已经通过。

## 当前应用配置

- 应用名称：`shenBCL`。
- Application (client) ID：`5df4a819-6add-4aba-a297-6e301deeb8a0`。
- Directory (tenant) ID：`51e084d1-df19-4b43-9b53-2876a45a5270`，用于申请资料；个人账号登录仍使用 `/consumers` 端点。
- 标识保存在 `src/shared/microsoft-app.ts`，均为公开标识，不是密码或 Client Secret。
- 2026-11-20 使用本应用 ID 调用 Microsoft 设备授权端点得到 HTTP 200、有效验证码响应及官方验证网址。检查未输入玩家账号、未交换或保存账号令牌。
- 普通玩家无需填写 Client ID；开发者环境变量及本机显式配置仍可覆盖默认应用。

## 登录方法与本项目选择

2026-11-16 核对 Microsoft 官方文档及 PCL 公开源码后的结论：用户描述的“启动器给一串代码，浏览器输入并同意”就是 **OAuth 2.0 设备代码授权**。代码由微软授权服务临时生成，不是启动器自行编造，也不是玩家的应用 Client ID。

| 方法 | 玩家体验 | shenBCL 状态与取舍 |
| --- | --- | --- |
| 设备代码授权 | 点击连接，复制一次性代码，打开微软网页并输入代码，完成登录和授权后自动返回启动器继续 | 已实现；优先把这一条接入并实测，符合用户熟悉的 PCL 操作 |
| 系统浏览器授权码 + PKCE | 点击登录，在默认浏览器中选账号并授权，通过本机回调回到启动器，通常不需要手输设备代码 | 可作为后续快捷入口；尚未实现，需要配置桌面应用回调、PKCE、请求状态核对、超时及本机回调监听 |
| 已登录账号自动刷新 | 首次授权后，重启启动器恢复账号，凭据仍有效时无需重复操作 | 已实现刷新和加密恢复路径；仍需真实账号验证，授权被撤销、凭据失效或账号要求再次验证时应重新登录 |

推荐先发布设备代码流，稳定后按体验需要增加 PKCE。设备代码和 PKCE 都需要开发者注册自己的公共客户端应用，变更登录方法不会解决当前缺少应用身份的问题。桌面应用不应内置 Client Secret；微软账号密码只在微软页面输入。离线名称或第三方外置登录属于另外的身份来源，不能据此显示为已验证的 Microsoft 正版账号。

“微软授权成功”也不是整个正版登录已经完成。后续还要完成 Xbox Live、XSTS、Minecraft 服务交换，验证 Java 版资格和角色资料，再同步皮肤并生成游戏启动身份。不同阶段的权限或服务拒绝应单独说明，不能简单归结为密码错误。

当前界面具备代码显示、复制、打开微软页面、过期倒计时、取消和自动轮询。主按钮先复制代码再打开官方网页；复制失败时保留代码并提示手动输入。尚未实现 PKCE。Microsoft 文档当前明确不返回 `verification_uri_complete`，因此设备代码流不能假定存在官方提供的“带好代码的免输入链接”。

## 开发者准备

1. 为 shenBCL 注册自己的 Microsoft 公共客户端应用，允许个人 Microsoft 账号。
2. 按 Microsoft 当前文档配置公共客户端设备代码流，并确认 Xbox Live／Minecraft 服务的接入要求和应用资格。
3. 将公开的应用 Client ID 填入启动器“账号与皮肤 → 应用接入配置”，或通过 `SHENBCL_MICROSOFT_CLIENT_ID` 环境变量提供。无需、也不接受 Client Secret。
4. 用拥有 Minecraft Java 版且已建立游戏角色的测试账号完成真实授权、角色同步、令牌刷新和游戏启动验证，再准备发行。

应用接入资格不由本地代码或自动化测试授予。当前已预配置本项目自己的 Client ID，普通玩家只需点击连接账号。没有使用其他启动器的应用标识。

参考：[Microsoft 设备授权流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)、[应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)、[桌面公共客户端配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)。Xbox 与 Minecraft 的接入条件以各服务当时的官方要求为准。Minecraft 应用审核短链 `https://aka.ms/mce-reviewappid` 本次可确认会跳转到 Microsoft Forms，但目标表单在当前网络下无法完成 TLS 连接，未核实当前表单内容、受理状态或审核细则；不将其视为已经完成或获准接入。

PKCE 的官方说明：[授权码流程](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)、[系统浏览器与本机回调](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/using-web-browsers)。后者是 MSAL.NET 示例，用于说明系统浏览器回调模式，不意味着本项目需要改用 C#。

PCL 流程对照：[公开 ModLaunch.vb](https://github.com/Meloong-Git/PCL/blob/main/Plain%20Craft%20Launcher%202/Modules/Minecraft/ModLaunch.vb) 的 `MsLoginStep1New` 同样先请求 Microsoft `consumers/oauth2/v2.0/devicecode`，scope 为 `XboxLive.signin offline_access`。这里只核对协议与交互，没有复制其代码或应用身份。

## 玩家操作

配置完成后点击“连接 Microsoft 账号”，复制设备代码，在 `https://www.microsoft.com/link` 输入代码并完成授权。请核对微软页面显示的应用名称。启动器不读取其他应用的登录状态，不自动输入密码，也不会向用户索取密码。

登录成功后首页显示角色名和账号类型，下载该角色的当前皮肤及披风。刷新按钮会刷新凭据并重新同步外观；退出按钮清除本机保存的账号记录。退出本机账号不会撤销 Microsoft 网站上的历史应用授权。

## 实现边界

- 设备授权端点：Microsoft `consumers/oauth2/v2.0`，scope 为 `XboxLive.signin offline_access`。
- 主进程完成 Xbox Live → XSTS → Minecraft 令牌交换、Java 版所有权及角色资料验证。
- 处理授权等待、服务降速、代码过期、拒绝授权、缺少所有权和刷新失效。
- Electron `safeStorage` 异步接口加密完整账号记录；加密不可用时不保存明文凭据。
- IPC 仅返回公开 Client ID、角色信息、皮肤图片、登录状态及用户代码，不返回设备密钥、访问令牌和刷新令牌。
- 皮肤只从 `https://textures.minecraft.net/texture/<hash>` 读取，拒绝重定向和任意来源，限制大小并检查 PNG 尺寸；界面加载本地 data URL。
- 实际启动在主进程使用正版 UUID、名称、访问令牌、Client ID 和 XUID。返回界面的启动计划对令牌脱敏。
- 刷新失败会阻止正版身份启动并提示重新登录，不自动降级为同名离线身份。

## 当前验证

2026-11-20 项目所有者已提供注册后的应用与目录 ID，默认应用身份已配置，设备代码端点的连通性与应用识别检查通过。Minecraft 应用审核仍是独立的外部步骤；普通玩家不需要注册开发者应用。

授权服务采用受控响应测试，覆盖完整交换、等待与降速、取消、所有权失败、加密存储失败、并发刷新和敏感字段隔离。另使用真实 XMCL 与本机 Java 验证正版参数生成及整个返回计划的脱敏。

尚未使用真实账号完成 Minecraft API 交换及完整正版启动验收。因此“流程已实现”不等于“线上接入已验证”。Minecraft 403 会提示检查应用审批状态和账号权限，不误报成密码错误。账号响应读取限 1 MiB，网络和响应体有超时，设备代码过期后停止轮询，取消的旧流程不会覆盖新登录状态。本地 PNG 和默认角色的 3D 展示可以独立使用。

申请说明应如实区分已验证的 Microsoft 身份和单独标记的离线模式，不能声称所有启动都强制正版认证。源码上传及申请填写步骤见 `REVIEW_SUBMISSION.md`。
