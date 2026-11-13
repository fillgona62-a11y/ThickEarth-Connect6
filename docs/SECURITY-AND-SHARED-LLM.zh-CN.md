# 安全修补与共享 LLM 配置

本次范围：保留现有规则、棋力与落子策略；修补共享服务和 Agent 接入的安全、权限与可靠性问题。

## 一个人配置，所有登录用户使用

使用顺序为：**当前账号可用的个人配置 → 服务器指定账号的共享配置 → 本地兜底**。

- 你先在网站注册并登录自己的账号，在「设置 → AI Agent」填入提供方、API 地址、模型和 Key，保存并启用。
- 在服务器指定你的账号作为共享来源。普通用户可以继续保存、修改、删除自己的个人配置；个人配置优先。
- 未配置个人 Key 的登录用户，在开局时将 AI 席位引擎选为 `LLM` 即可。`online` 房间仍是人与人联网对战，LLM 对手从对局设置页创建。
- 浏览器只能看到自己的配置和“共享是否可用”，收不到共享账号的地址、Key、Key 尾号或账单。
- 共享用于落子，不会自动开放共享 Key 供任意教练聊天或连接测试使用。

Web 模式必须明确指定共享账号，不再自动选择最早填写 Key 的访客。指定账号不存在、未启用或 Key 无法解密时，共享会显示不可用。

### Linux / systemd

已提供的两个 service 模板都读取可选文件 `/etc/thickearth/shared-llm.env`。

```bash
sudo install -d -m 700 /etc/thickearth
sudo install -m 600 deploy/shared-llm.env.example /etc/thickearth/shared-llm.env
sudo nano /etc/thickearth/shared-llm.env
```

将其中 `AI_SHARED_USER_EMAIL=owner@example.com` 改为你**已经注册并配置好模型的账号邮箱**。也可改用该账号的 `AI_SHARED_USER_ID`；两者同时存在时 ID 优先。文件不需要填写 API Key。

若原 service 已安装，请更新 service 模板或在现有 `[Service]` 下补充：

```ini
EnvironmentFile=-/etc/thickearth/shared-llm.env
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart thickearth
```

### Windows / PowerShell 本地验证 Web 模式

```powershell
$env:APP_MODE = 'web'
$env:PORT = '8080'
$env:COOKIE_SECURE = '0' # 仅本地 HTTP 验证；正式 HTTPS 部署使用 1
$env:AI_SHARED_LLM = '1'
$env:AI_SHARED_USER_EMAIL = '你在这个网站注册的邮箱'
npm start
```

桌面数据库与网站数据库可能不同。共享读取的是**网站使用的数据库**中指定账号的配置，源码压缩包不包含数据库或真实 Key。

### 额度与成本归属

共享调用计入提供 Key 的账号的每局、每月上限。每位借用者另受 `AI_SHARED_MAX_CALLS_PER_USER` 限制，默认每月 100 次。每个计费账号最多同时请求 4 次，每位请求者最多同时请求 2 次，可分别用 `AI_MAX_CONCURRENT`、`AI_MAX_CONCURRENT_PER_USER` 调整。

请求开始前就会持久化预占额度；失败、超时和非法回复也计为一次，避免通过并发或失败重试绕过上限。达到上限、并发限制、提供方故障或格式校验失败时，沿用本地兜底机制。共享不代表无限调用；请在你的账号中设置适合站点规模的总额度。

## 已修补的问题

1. 桌面 API 校验本地 Host、Origin 和浏览器跨站元信息；桌面模式拒绝绑定公网地址。
2. 有 JSON 正文的接口要求 `application/json`，阻止使用简单表单类型跨站提交；API 响应禁止缓存，增加 CSP。
3. 已存 Key 绑定完整 API 前缀。更换地址或前缀后必须重新输入 Key；连接测试不再把旧 Key 发往新地址。
4. Web 提供方强制 HTTPS，拒绝私网、保留地址、IPv4 映射 IPv6 及转换地址；在实际 socket DNS 查询时验证并直接使用批准的 IP，避免二次解析绕过。禁止携带凭据跟随重定向。
5. 超时覆盖连接与响应正文读取；保留响应大小上限。
6. 增加 API、注册和登录请求限流；仅信任本机代理附加的转发地址，修补限流表满时清空历史的问题。
7. 观战者无法读取教练聊天或写入笔记、生成报告与分析；参与者之间的教练聊天按账号隔离。
8. 修复在线房间开始时写入不存在的阶段值的问题。
9. 修复 Agent SSE 座位信息丢失；增加连接数量和缓冲上限，并重新检查连接授权。换发令牌立即关闭旧座位连接。
10. Agent 提交必须携带整数 `turnId`；正文读取后重新验证令牌。超时计算完成后再次检查局面，防止覆盖已经到达的真实动作。
11. Agent 截止时间不因轮询刷新，并持久化到座位数据；重启后恢复，包括无人打开网页的对局。
12. AI 调度串行执行并在异步返回后核验局面；CSV 对可执行公式前缀作转义。

## 数据升级与验证

数据库自动从版本 2 升级至版本 3，仅增加调用请求者字段和索引。已验证现有对局与加密凭据在升级后保留。上线前一起备份网站数据库及同目录 `.ai-secret`；不需要删除旧数据。并发配额控制按当前单 Node 服务进程设计。

```bash
npm test
npm run smoke
npm run test:i18n
npm run evaluate:agents
```

新增测试使用临时数据库和模拟提供方，验证共享调用、个人优先、账号隔离、成本预占、SSRF、跨站防护、完整超时、在线开局及 Agent 令牌/SSE/截止时间。未消耗真实模型额度。真实提供方可用性及生产反向代理配置需在部署环境验证。
