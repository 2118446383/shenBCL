# shenBCL 源码上传与 Minecraft AppID 申请

这份说明对应当前源码材料。应先通过本地构建、测试和登录流程检查，再生成并上传最终源码包。Microsoft 应用注册与 Minecraft Services 应用审核是两个步骤；已有 Client ID 不表示 Minecraft Services 已批准接入。

## 申请入口

官方短链：**<https://aka.ms/mce-reviewappid>**。

2026-11-20 已确认该地址返回 HTTP 301 并跳转到 Microsoft Forms。当前网络访问目标表单会发生连接重置，因此本次未核实表单的全部字段、受理状态或审核时长。

备用完整地址是同一次跳转返回的目标，不是另一个申请渠道：

<https://forms.office.com/Pages/ResponsePage.aspx?id=v4j5cvGGr0GRqy180BHbR-ajEQ1td1ROpz00KtS8Gd5UNVpPTkVLNFVROVQxNkdRMEtXVjNQQjdXVC4u>

你提供的截图列出了 **Associated website or domain**。这能说明需要一个审核人员可以访问的项目链接，截图本身不能证明当前表单要求上传源码压缩包附件。下面准备的是供审核阅读的 GitHub 源码仓库；如果实际表单另有附件或其他材料要求，应按当时表单填写。

## 源码包的目录

先在本机解压提交用的源码 ZIP。打开解压后的最外层目录，应看到：

```text
README.md
SOURCE_MANIFEST.sha256
arcane-launcher/
  package.json
  package-lock.json
  electron-builder.json
  vite.config.ts
  tsconfig.main.json
  tsconfig.renderer.json
  src/
  scripts/
  docs/
  build/
  THIRD_PARTY_NOTICES.md
tests/
  account.test.ts
  ...
```

`tests` 与 `arcane-launcher` 是同级目录，保持你移动后的布局。不要再把 `tests` 放回 `arcane-launcher` 里面；测试运行脚本按同级目录寻找源测试。

发布源码时保留程序源码、构建配置、锁定文件、测试和第三方许可材料。提交用 ZIP 应由明确的源码清单生成，不应直接压缩整个开发文件夹，也不应包含 `node_modules`、`dist`、`release-current`、旧版本、`.local`、`.ui-*`、`.tmp`、账号数据、令牌、浏览器缓存、真实实例、游戏或整合包文件。

**GitHub 仓库应直接显示解压后的源码。不要仅上传一个 ZIP 就把它当成可浏览的源码仓库。**

## 在 GitHub 手动上传

1. 自行登录 <https://github.com>，打开 <https://github.com/new>。
2. 仓库名称可填写 `shenBCL`。选择你的账号作为所有者。
3. 为方便审核，建议选择 **Public**。这会让任何人都能查看仓库中的文件；先使用已经去除本地数据的提交用源码包。若选择 Private，需要按审核方明确给出的办法提供访问权限，不能只提交审核人员打不开的私有链接。
4. 可以不自动生成 README、`.gitignore` 或许可证，使用源码包里已有的文件即可。当前项目标为 `UNLICENSED`，不要为了创建仓库随意选择一个新的开源许可证；第三方组件的许可文件继续保留。
5. 创建仓库后，空仓库页面可点击 **uploading an existing file**；已有文件的仓库使用 **Add file → Upload files**。
6. 第一批把解压目录最外层的 `README.md`、`SOURCE_MANIFEST.sha256` 和整个 `tests` 文件夹拖入上传区域。填写提交说明，例如 `Add project overview and tests`，点击 **Commit changes**。
7. 回到仓库根目录，再次使用 **Add file → Upload files**，第二批拖入整个 `arcane-launcher` 文件夹，填写 `Add launcher source` 并提交。上传的是这个文件夹本身，使仓库里保留 `arcane-launcher/src` 等路径。
8. 上传后确认仓库根目录包含 `README.md`、`SOURCE_MANIFEST.sha256`、`arcane-launcher`、`tests`；不要多套一层 ZIP 的外壳文件夹，也不要把源码都堆到根目录。打开 `arcane-launcher/src/main/services/account.ts`，确认登录实现可以直接阅读。
9. 复制仓库主页地址，格式例如 `https://github.com/你的用户名/shenBCL`。这是申请中的项目／源码链接。

GitHub 官方文档当前规定：**浏览器每次最多上传 100 个文件，单个文件最多 25 MiB**。拖入文件夹时，其中的每个文件都会计入数量；不能把整个文件夹算作一个文件。

如果第二批提示超过 100 个文件，不要漏传文件或改为只上传 ZIP。可以在仓库中新建 `arcane-launcher/package.json`，填入源码包里对应文件的完整内容并提交，先建立该目录；然后进入 `arcane-launcher` 目录，分别上传该目录中的其余根级配置文件，以及 `src`、`scripts`、`docs`、`build` 文件夹，每批都不超过 100 个文件。确保所有路径最终与上面的目录树一致。也可按 GitHub 官方文档改用 GitHub Desktop 或 Git 上传。

GitHub 上传说明：<https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository>。

## 检查审核人员能否阅读

对于 Public 仓库，可用未登录的浏览器窗口打开仓库链接，确认根 README 和源码文件都可阅读。检查 `README.md` 对产品和登录流程的描述与源码一致。

可供审核定位的主要文件：

| 仓库路径 | 内容 |
|---|---|
| `arcane-launcher/src/shared/microsoft-app.ts` | shenBCL 自有应用的公开标识 |
| `arcane-launcher/src/main/services/account.ts` | 设备码授权、Xbox／XSTS／Minecraft 交换、资格和角色检查 |
| `arcane-launcher/src/main/main.ts` | 本机加密凭据持久化、受限 IPC 与启动流程 |
| `arcane-launcher/src/main/preload.ts` | 界面可调用的受限接口 |
| `arcane-launcher/src/renderer/components/AccountDialog.vue` | 玩家授权界面 |
| `arcane-launcher/src/main/services/launch.ts` | 真实游戏启动身份与参数处理 |
| `tests/account.test.ts` | 受控响应下的登录流程检查 |
| `tests/authenticated-launch.test.ts` | 正版启动参数与敏感信息处理检查 |

需要复现构建时，在已安装 Node.js 和 npm 的环境中进入源码包的 `arcane-launcher` 目录，依次运行：

```powershell
npm ci
npm run build
npm test
```

`tests` 应继续位于同级目录。自动化测试使用受控响应，不能代替真实账号登录或完整游戏运行验收。

## 申请资料对照

下面根据你提供的截图整理；实际表单若有不同提示，以当前表单为准。

| 字段 | 建议内容 |
|---|---|
| Application Name | `shenBCL` |
| Application ID | `5df4a819-6add-4aba-a297-6e301deeb8a0` |
| Tenant ID | `51e084d1-df19-4b43-9b53-2876a45a5270` |
| What type of request is this? | 新应用对应 `New AppID for Approval`，以当前选项文字为准 |
| Contact Information | 填写你本人能够接收审核通知的邮箱，并按表单要求核对 |
| Associated website or domain | 填写刚创建、审核人员能够访问的 GitHub 仓库主页完整地址 |
| Justification | 可参考下一段如实说明，并替换源码链接 |
| EULA／Usage Guidelines 确认 | 由你本人阅读相关条款后作出确认 |

Application ID 与 Tenant ID 是应用的公开标识，不是密码。**不需要把 Client Secret、账号密码、验证码、访问令牌、刷新令牌或本机加密账号文件上传到仓库或填写为源码材料。** 当前设备码登录使用个人 Microsoft 账号的 `/consumers` 端点；Tenant ID 在这里作为申请资料，不应拿来替换登录端点。

## 可参考的英文申请说明

将 `[SOURCE_URL]` 替换为你实际上传完成的仓库地址，并在提交前核对描述与最终源码一致：

> I am developing shenBCL, a Windows desktop launcher for Minecraft: Java Edition. I am requesting access to Minecraft Services so users can authorize their own personal Microsoft accounts using the OAuth 2.0 device authorization flow. For Microsoft-authenticated launches, the launcher exchanges tokens through Xbox Live and XSTS, checks Java Edition entitlement, and retrieves the player's UUID, in-game name, skin and cape. Credentials remain in the main process and are stored locally using Windows-backed encryption. Failed or revoked Microsoft authentication is not silently converted to an offline identity. The launcher also provides a separately labeled local/offline profile mode; this is not presented as a verified Microsoft account. Source code and authentication implementation are available at: [SOURCE_URL].

当前程序保留明确标注的本地／离线身份，因此不能声称“所有游戏启动都必须成功登录 Microsoft”。上面的说明只将微软认证和资格要求限定在 Microsoft 正版身份的启动流程。

## 提交之后

在表单内核对应用名称、两个 ID、邮箱与源码链接，再由你本人提交。记录提交成功页面或邮件即可；本次没有代你提交，也不承诺固定审核时长或一定获批。

只有本地检查完成、源码已经可以访问，才能称为“提交材料已准备好”。只有审核结果明确通过，且真实账号完成授权、角色与皮肤同步、重启恢复及正版启动验收后，才能称为“线上正版接入已验证”。审核前遇到 Minecraft 服务拒绝时，应按实际错误提示处理，不能把它当成已获准接入。
