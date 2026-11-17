# XuanEcho · 萱之回响

> 青萱沐雨时，旧语应时来。

让曾经用过的提示词，在合适的时候再次出现。XuanEcho 是使用 TypeScript、React 和 WXT 构建的 Chrome Manifest V3 扩展。

## V0.1 功能

- 默认暂停；阅读采集说明后，点击「同意并开启记录」才开始记录。
- 记录启用后在 ChatGPT 实际提交、且在页面中出现的用户文本，不回填旧聊天、不保存 AI 回复。
- 历史按最近发送时间排序，每条以「时间、单行摘要、展开、删除、填入」显示；长文本自动省略，点击展开可查看完整原文，支持中文片段搜索。
- 一键填入当前 ChatGPT 输入框，**不会自动发送**。输入框已有草稿时会提示，避免覆盖。
- 随时暂停记录；清空全部历史需要确认。
- 数据保存在 `chrome.storage.local`，无需账号、后端、远程模型或云同步。

第一版只针对 ChatGPT 的普通文本交互，支持 `https://chatgpt.com/` 和 `https://chat.openai.com/`。附件、语音、其他 AI 网站、频率推荐和语义模板留待后续版本。

## 安装与使用

```bash
npm install
npm run build
```

1. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载未打包的扩展程序」，选择项目中的 **`.output/chrome-mv3`**。
3. 如果此前已经打开 ChatGPT，请刷新该页面，使内容脚本生效。
4. 在 ChatGPT 页面打开 XuanEcho，阅读本地记录说明，点击「同意并开启记录」。
5. 自行发送一条文本消息，再打开扩展，就可以搜索和复用。

macOS 选择隐藏目录时，可按 `Command + Shift + G` 输入完整路径。更新正式版本后，需要重新运行构建、刷新扩展，并刷新 ChatGPT 标签页。正式构建不依赖开发服务器。

## 数据与隐私

生产版申请 `storage` 和 `scripting` 权限，站点范围仅限两个 ChatGPT 域名。`scripting` 仅用于页面连接失效时重新加载扩展自带的页面脚本，不读取其他网站。内容脚本只接收采集开关和用户发起的填入操作，整个历史库仅对扩展页面开放。

记录前需同时满足：用户已经启用记录、发生发送操作、新的用户消息出现在页面中、其文本与本次发送内容匹配。仅按 Enter、编辑草稿、输入法组合、页面重渲染或 AI 回复都不足以产生记录。采集使用页面 DOM，不拦截网络请求，不调用 ChatGPT 私有接口。页面确认表示网站已显示该次提交，不等同于服务端投递回执。

V0.1 **每次发送保存一条独立事件**：字段为 `id`、`text`、`source`、`createdAt`。保留文本原文与发送时间；同一页面消息 ID 不会重复写入，相同文本再次发送则另存一条。暂不聚合文本，也不把填入操作当作发送次数。存储采用版本化键 `xuanecho.v1`，由后台串行写入，避免多个标签页互相覆盖。

暂停会使旧采集令牌失效；清空历史会更换令牌并取消页面上待确认的采集，记录开关保持原状。删除和清空仅影响本地提示词库，不删除 ChatGPT 对话。重新打开浏览器后历史仍在；卸载扩展会移除该扩展的本地数据。

## 开发与测试

```bash
npm run dev          # 开发与热更新，加载 .output/chrome-mv3-dev
npm run compile      # TypeScript 检查
npm test             # 纯逻辑与存储测试，无需下载浏览器
npx playwright install chromium
npm run test:e2e     # 正式构建 + Chromium 扩展集成测试
npm run test:all     # 正式构建 + 全部自动化测试
```

推荐使用 WXT 兼容的 Node.js LTS 版本。现有 Node.js 23.11.0 环境已用于本轮检查，不会自动替换你的运行环境。

若 npm 遇到 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，应修复可信证书链；不要关闭 TLS 校验。本次 macOS 环境通过单次命令 `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm install` 使用系统 CA 文件解决，未修改全局 npm 或证书配置。

2026-11-17 验证结果：`npm run compile` 通过；`npm run test:all` 正式构建成功，12 项纯逻辑测试与 11 组扩展集成测试全部通过（23/23）。开发服务器构建及开发版 MV3 弹窗在独立 Chromium 中加载通过。

测试使用独立的临时 Chrome 配置和合成数据，不读取个人浏览器资料，也不向真实 ChatGPT 发送测试消息。集成测试加载正式 MV3 扩展，把测试域名请求替换成本地 fixture，验证授权、采集、搜索、删除、清空、填入、草稿保护、暂停、多标签页和重启持久化。测试截图与报告在忽略的 `test-results/` 下。

**验证边界**：自动化页面不能替代真实 ChatGPT 的最终验收。本轮访问真实网站时停留在「请稍候…」验证页面，未能加载真实编辑器；需在你已登录的 Chrome 中按下面的步骤完成实站核验。网站 DOM 改版可能导致漏采集；无法确认的消息不会凭猜测入库。

### 实站验收步骤

1. 加载 V0.1、刷新 ChatGPT，确认首次未开启记录时发送消息不会入库。
2. 开启记录，分别用 Enter 和发送按钮提交两条不同的纯文本提示词；确认内容、换行与时间正确，AI 回复不入库。
3. 编辑未发送草稿、使用 Shift+Enter 换行和中文输入法确认词语，确认这些操作不会独立产生记录。
4. 搜索中文片段、展开并收起完整原文，清空输入框后点击「填入」，确认文本正确且没有自动发送；有草稿时应明确提示。
5. 删除一条；打开清空确认先取消，再确认清空。确认列表与实际操作一致。
6. 暂停后发送新消息，确认不记录；关闭并重开 Chrome，确认此前保留的历史仍在。
7. 在非 ChatGPT 页面或没有编辑器的页面尝试填入，确认有清楚反馈。

## 输入框兼容与开发版排查

已根据实站反馈补充不带 `id` 的 `.ProseMirror[role="textbox"][contenteditable]` 输入框适配；旧版仅依赖 `prompt-textarea` 标识，会同时导致「未找到输入框」、无法采集和无法填入。回归测试覆盖无 ID 编辑器的 Enter/按钮发送、填入，以及隐藏副本和历史消息编辑框的排除。

使用 `npm run dev` 时保持终端运行；代码热更新后刷新 ChatGPT 页面。若仍运行旧脚本，可重启开发命令，在 `chrome://extensions` 刷新 XuanEcho，再刷新 ChatGPT。开发版应加载 `.output/chrome-mv3-dev`，正式版才加载 `.output/chrome-mv3`。确认弹窗显示「已连接 ChatGPT」，再由用户主动点击「同意并开启记录」，然后发送一条新文本；暂停状态与启用前的旧消息不会被自动记录。

### 正式版显示尚未连接

开发版与正式版使用同一套业务源码，但开发版通过 WXT 动态注册和重载页面脚本，正式版使用 `manifest.json` 中的静态内容脚本配置；浏览器中的扩展 ID、站点权限和本地数据彼此独立。

弹窗出现但无法连接，表示当前页面尚无可用的消息接收端。现在打开弹窗或点击「重试」时，会在接收端缺失的情况下检查当前标签页，再尝试加载已打包的 `content-scripts/content.js`。仅允许两个 ChatGPT 域名，不自动改变记录开关，也不导入旧聊天。重复重连会共用同一次加载任务，避免重复监听。页面完成初始授权状态读取后，才向弹窗确认连接。

1. 执行 `npm run build` 后，在 `chrome://extensions` 刷新**已有的正式版**扩展，确保新增的 `scripting` 权限生效。
2. 保持开发版关闭，回到 ChatGPT 页面打开正式版弹窗，点击「重试」。
3. 若提示站点权限问题，在该正式版的详情页允许访问当前 ChatGPT 域名。若提示页面脚本加载失败，查看扩展卡片的错误信息。
4. 正式版不需要运行 `npm run dev`；无需在网页 Console 粘贴诊断代码。

### 开启后仍未记录，如何 debug

当前适配同时支持旧的 `[data-message-author-role="user"]` 与实站反馈的 `[data-user-message-bubble]`，并支持中文发送按钮和表单提交。弹窗中的采集诊断入口已按用户要求移除，内部 `page:status` 接口仍供自动化测试与排查使用。

开发模式可在 **ChatGPT 页面**的 DevTools Console 中筛选 `XuanEcho`，查看无内容的阶段日志。`npm run dev` 所在终端主要显示编译信息。`sendAttempts`、`confirmedMessages`、`savedRecords` 依次对应识别发送、确认新增用户消息和保存成功；`waiting-message/timeout` 表示等待页面消息确认，`text-mismatch` 表示文本未匹配，`error` 表示保存失败。这些计数属于当前页面脚本，刷新或重新加载脚本后重置。

诊断只包含阶段、计数和时间，不包含聊天原文或采集令牌。普通使用时先检查弹窗的连接反馈与记录开关，再发送一条新文本。

## 代码位置

- `lib/domain.ts`：记录类型、版本化数据校验、搜索和站点识别。
- `lib/repository.ts`：持久化与串行读写、授权令牌和幂等去重。
- `lib/messages.ts`：扩展消息协议与失败反馈。
- `lib/chatgpt.ts`：页面适配、发送确认和输入框编辑。
- `entrypoints/background.ts`：唯一写入入口、消息来源校验和开关广播。
- `entrypoints/content.ts`：页面生命周期、采集和填入消息处理。
- `entrypoints/popup/`：中文弹窗和本地历史管理。
- `tests/`：存储测试、合成 ChatGPT 页面和真实 Chromium MV3 集成测试。
- `docs/HANDOFF.md`：产品背景、后续版本规划与验收记录。

实现依据：[Chrome 消息通信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Chrome 本地存储](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)。
