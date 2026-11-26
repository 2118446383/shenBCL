# 第三方组件与许可说明

本文件记录 shenBCL 启动器 0.3.7 使用的主要第三方组件。精确安装版本与传递依赖以 `package-lock.json` 为准。发行包中的 npm 代码已合并进 JavaScript，随包的 `THIRD_PARTY_LICENSES.txt` 汇总上游许可与声明；Electron／Chromium 许可文件另行保留。

发行包只包含启动器与其运行依赖。原版游戏本体及美术资源由启动器从 Mojang 官方端点下载。shenBCL 自行制作标志、版本图标、默认预览角色和首页环形动效。

## 下载与元数据服务

| 服务 | 归属与文档 | 当前用途 |
| --- | --- | --- |
| BMCLAPI | **bangbang93** 及项目贡献者；[项目文档](https://bmclapidoc.bangbang93.com/)、[项目仓库](https://github.com/bangbang93/BMCLAPI) | 仅用于受支持的 Forge／NeoForge 加载器路径 |
| MCIM（Minecraft Mod 信息镜像） | MCIM 团队及项目贡献者；[项目网站](https://www.mcimirror.top/)、[接口文档](https://www.mcimirror.top/docs)、[项目组织](https://github.com/mcmod-info-mirror) | Modrinth 元数据及受支持模组文件的备用来源 |
| Modrinth | Modrinth 及内容作者；[API 文档](https://docs.modrinth.com/api/) | 模组／整合包搜索、兼容版本、必需依赖元数据和文件下载 |

感谢 BMCLAPI（bangbang93）和 MCIM 提供公共镜像服务。下载中心保留两项服务署名。接入按各自公开文档独立实现，使用官方服务与已适配备用来源，不复制 PCL 下载代码或服务凭据。上述服务是网络来源，不是打包在本应用中的代码组件；服务与内容各自的条款继续适用，不能将某个服务端仓库的开源许可当作其分发内容的许可。

镜像可用性和下载速度取决于网络、服务状态和缓存。目前没有相同条件的 PCL 性能对比数据，不宣称下载速度已优于 PCL。Microsoft 授权及账号令牌请求不经过这些下载镜像。

## 运行与界面组件

| 组件 | 许可证 | 使用方式与来源 |
| --- | --- | --- |
| XMCL Core 2.16.3 | MIT | 版本解析、启动参数和游戏启动；[Voxelum/x-minecraft-launcher](https://github.com/Voxelum/x-minecraft-launcher) |
| XMCL Installer 6.3.7 | MIT | 原版下载与安装；同一 XMCL 项目 |
| XMCL Unzip 2.1.2 | MIT | XMCL 依赖的 ZIP 读取适配；通过 npm override 固定以避开 2.2.0 发布错误 |
| XMCL Yauzl 2.10.0 | MIT | XMCL 安装器 ZIP 依赖；[XMCL packages/yauzl](https://github.com/Voxelum/x-minecraft-launcher/tree/master/packages/yauzl) |
| Vue 3 | MIT | 界面及 Vue 运行时；[vuejs/core](https://github.com/vuejs/core) |
| Lucide Vue Next | ISC；部分图标源自 MIT 许可的 Feather | 界面图标；[lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| Electron | MIT，包含其他许可证下的第三方代码 | 桌面窗口、隔离桥接与本地能力；[electron/electron](https://github.com/electron/electron) |
| Node.js | MIT，包含其他许可证下的第三方代码 | Electron 内嵌的本地运行环境；[nodejs/node](https://github.com/nodejs/node) |
| Chromium | BSD 风格与多种第三方许可证 | Electron 的网页渲染引擎；[Chromium](https://www.chromium.org/) |

XMCL 的传递依赖还包括其 ASM、文件传输、Forge 页面解析组件，以及 ZIP、TAR、HTTP 等基础库。它们随 npm 包发布的许可文本汇总到 `THIRD_PARTY_LICENSES.txt`；此表不替换这些传递依赖的完整许可。

其中 XMCL Unzip 随包声明 `Copyright (c) 2021 CI010`；Yauzl 上游许可声明 `Copyright (c) 2014 Josh Wolfe`。`@xmcl/yauzl` 保留其 `LICENSE.upstream`，分发时同样应保留该文件。

## 开发与构建工具

| 组件 | 许可证 | 来源 |
| --- | --- | --- |
| TypeScript | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| Vite、Vue Vite 插件 | MIT | [vitejs/vite](https://github.com/vitejs/vite)、[vitejs/vite-plugin-vue](https://github.com/vitejs/vite-plugin-vue) |
| vue-tsc／Vue Language Tools | MIT | [vuejs/language-tools](https://github.com/vuejs/language-tools) |
| esbuild | MIT | [evanw/esbuild](https://github.com/evanw/esbuild) |
| tsx | MIT | [privatenumber/tsx](https://github.com/privatenumber/tsx) |
| electron-builder | MIT | [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) |

构建工具和运行时依赖的范围不同。正式发布包需按实际包含内容保留许可，不应仅按这份主要组件列表判断全部义务。

## XMCL 版权与 MIT 许可

XMCL Core 与 Installer 所附许可声明：

```text
MIT License

Copyright (c) 2023 ci010 (cijhn@hotmail.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vue 版权与 MIT 许可

```text
The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide 许可

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Lucide 包中关于 Feather 的完整历史许可继续适用，详见其随包 `LICENSE`。

## Electron、Node.js 与 Chromium

Electron 的 MIT 许可包含以下版权归属：

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.
```

其完整许可见 Electron 随包 `LICENSE`。Electron 分发的 Chromium 与 Node.js 同时包含其他开源项目，应保留 Electron 发布包中的 `LICENSE`、`LICENSES.chromium.html` 和其他通知文件；不能仅保留 Electron 的 MIT 标识。

## 设计参考、规划组件与账号接入

KAMUCL 视频和 PCL 等产品用于功能讨论与设计参考，未作为当前项目的代码依赖。当前已集成 skinview3d、skinview-utils 与 Three.js；未集成 VoxLink、Litematica、ReplayMod、Flashback、AI SDK 或 MCP 服务。

后续加入这些组件前，需要核对对应仓库、实际分发产物和所用版本的许可。源码公开不必然允许复制或再分发，也不能把同一作者不同仓库的许可混用。

Minecraft、Mojang 与 Microsoft 的名称、商标、游戏内容及服务归相应权利人所有。本项目是第三方 Java 版启动器，与其没有隶属或认可关系。微软账号代码流程已实现，使用项目所有者注册的公开应用身份，Minecraft Services 白名单复审与线上实测尚待完成。

## 0.2 新增组件与设计参考

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| skinview3d 3.4.2 | MIT | Minecraft 角色、皮肤、披风和动作预览；https://github.com/bs-community/skinview3d |
| skinview-utils 0.7.1 | MIT | 皮肤纹理工具，skinview3d 的依赖；https://github.com/bs-community/skinview-utils |
| Three.js 0.156.1 | MIT | 启动器内的 3D 皮肤渲染；https://github.com/mrdoob/three.js |
| @resvg/resvg-js 2.6.2 | MPL-2.0 | 仅开发时生成 PNG／ICO 图标，不是渲染器运行依赖；https://github.com/yisibl/resvg-js |

三项新增渲染依赖的完整许可副本随分发放在 docs/licenses/。原始包的 LICENSE 继续保留。

Noctra、Empire、CRYSO 的 Behance 作品与用户提供的 KAMUCL 截图仅用于设计分析。发行包没有包含这些作品的图片或源码。shenBCL 标志、场景几何和默认像素角色为本项目制作。具体链接与实际查看范围见 docs/DESIGN_RESEARCH.md。

Minecraft 的 [EULA](https://www.minecraft.net/eula) 和 [使用准则](https://www.minecraft.net/usage-guidelines) 适用于相关游戏及服务。
