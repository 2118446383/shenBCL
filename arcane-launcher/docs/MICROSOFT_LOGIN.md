# shenBCL 的 Microsoft 与 Minecraft 登录

shenBCL 使用项目所有者注册的公共客户端 AppID，入口为 Microsoft 个人账号 /consumers。应用信息见 src/shared/microsoft-app.ts。设备代码授权使用 XboxLive.signin 和 offline_access。后者用于获取刷新凭据。

1. 用户从启动器发起设备码申请，打开固定的 Microsoft 官方页面，核对授权对象并填写短期设备码。密码和账号验证码在浏览器官网输入。
2. 主进程轮询 Microsoft 官方端点，依次与 Xbox Live、XSTS 和 Minecraft Services 交换令牌。Minecraft Services 的 entitlements/mcstore 必须返回 Java 版资格，minecraft/profile 必须返回有效角色。
3. 成功后的本机账号记录由 Electron safeStorage 使用 Windows 加密保存。渲染器取得登录进度、用户可见的授权码及公开角色资料。访问令牌、刷新令牌和设备密钥由主进程处理，Minecraft 客户端通过游戏参数接收本次会话令牌。
4. 重启时先显示缓存资料，再请求官方服务恢复和验证会话。客户端及服务端在实际运行前重新在线验证所有权。账号退出、会话失效或验证失败时拒绝运行。服务端也要求 online-mode=true。
5. 通过验证后可预览官方角色当前皮肤及官方活动披风。本地 PNG 功能仅用于启动器预览。

用户无需注册应用。0.3.7 使用构建内的 shenBCL AppID，旧版的本地设置、环境变量覆写与开发者 AppID 输入已经移除。

## 验收状态

2026-11-20 的前一版验证了 Microsoft 设备码端点返回 HTTP 200。Mojang Enforcement 已通知先前的 Minecraft Services AppID 白名单申请未获批准。真实账号完成授权后能否读取 Java 版资料、皮肤、重启恢复和成功启动，须在复审获准后逐项验证。自动化测试使用受控的服务响应。

官方流程资料在 [Microsoft 设备代码流](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) 与 [Minecraft AppID 申请](https://aka.ms/mce-reviewappid)。
