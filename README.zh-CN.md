# ThickEarth 厚土 · 六子棋（Connect6）

[English](README.md) · **中文**

一个可以打、可以看、可以导出的六子棋 Web 应用。有前后端、SQLite 存对局、内置 AI 对手、赛后分析与点评、棋谱导出，并且对外开放 **Agent 座位**——任何外部进程（自己的脚本、LLM 应用、Claude Code / Codex 这类 CLI Agent）都可以领一个令牌坐进棋盘，跟本地 AI 或另一个 Agent 对打。

零第三方运行时依赖，只用 Node 内置模块（含 `node:sqlite`）。需要 **Node >= 22.5**。

```
npm test           # 测试与安全回归
npm run smoke      # 端到端跑一局，校核导出 / 分析 / 统计 / 静态资源
npm start          # 桌面模式，127.0.0.1 随机端口
```

---

## 规则（取自评测 baseline）

| 项 | 值 |
|---|---|
| 棋盘 | 19 × 19，列 A–S、行 1–19（行 1 在最上方） |
| 先后 | 黑先（0 号座位） |
| 每回合落子 | 黑方第一回合 **1 子**，此后每回合 **2 子** |
| 获胜 | 横、竖、斜任一方向连成 **6 子或以上**，立即获胜 |
| 不存在 | PASS、禁手、认输、吃子、提子 |
| 棋盘填满无人连六 | 和棋 |

**一次 AI 决策 = 一颗落子**，与 baseline `get_move(board)` 的决策边界一致；因此「一回合」可能跨 1~2 次决策。单次决策的硬超时按 10 秒设计（仅作参考，评测以平台实际运行为准）。

两个容易踩的点：

- **一子成六即终局**。一回合的第二子还没落下也算赢——落子后立刻判定，不等回合走完。
- **六子以上都算赢**。七连、八连不设「长连禁手」，判定是 `run.length >= 6`。

规则引擎是纯函数（`shared/rules.js`），前端回放直接 import 同一份代码重放，不存在两套实现。

---

## 功能对照

| 要求 | 实现 | 位置 |
|---|---|---|
| 棋类 Web 应用，有前后端 | 原生 ESM 前端 + Node HTTP 后端，30+ REST 路由，SSE 实时推送 | `web/`、`server/` |
| 数据库存储对局信息 | SQLite：对局、动作日志、用户、AI 用量、教练报告 | `server/db.js` |
| 不限制语言 | 后端只有 Node，前端零构建；Agent 侧任意语言，走 HTTP | — |
| Agent 功能，能自己接入 AI | 外部 Agent 座位：令牌 + 回合契约 + SSE | `server/agent-seats.js` |
| 对局分析 | 本地分析引擎，逐手算棋型威胁与得失 | `shared/analysis.js` |
| 与自己的 AI 对战 | `mode=ai` 人机 / `selfplay` AI 自对弈 / `arena` Agent 打 AI 或 Agent | `server/games.js` |
| 对战后给缺点和分析 | 教练报告：优点、缺点、关键失误、改进建议、训练计划 | `server/coach.js` |
| 棋谱导出 | JSON / Markdown / 文本三种格式（MD 含 X/O 终局图），另有试玩数据 CSV | `server/export.js` |

---

## 快速开始

拿到代码就等于装好了——没有任何编译或生成步骤：

```bash
git clone https://github.com/fillgona62-a11y/ThickEarth-Connect6.git
cd ThickEarth-Connect6
```

没装 Git？打开仓库页面，点绿色的 **Code** 按钮选 **Download ZIP**，解压即可。Windows 上可以直接双击 `start.bat`，不用敲命令：它会先检查 Node 是否在 `PATH` 里，然后在 8787 端口起服务并打开浏览器。想要无黑窗的静默启动，用 `launch.pyw`（桌面快捷方式指向它）；它会把 `DB_PATH` 指到已安装桌面版的数据库，已有 AI 配置不会丢。

之后，需要 Node 22.5 或更新版本：

```bash
# 1. 直接跑，无 npm install 步骤（没有依赖）
npm start                        # 桌面模式：127.0.0.1:随机端口

# 2. Web 模式（有注册/登录，适合演示和部署）
APP_MODE=web PORT=8080 npm start
# 打开 http://127.0.0.1:8080

# 3. 跑测试与端到端校验
npm test
npm run smoke
npm run test:i18n                # 中英文案键一致性
```

环境变量：

| 变量 | 说明 |
|---|---|
| `APP_MODE` | `desktop`（默认，免鉴权、只听 127.0.0.1）或 `web`（注册登录、按 Origin 校验） |
| `PORT` / `HOST` | Web 模式默认 8080 / 0.0.0.0；桌面模式默认随机端口 / 127.0.0.1 |
| `DATA_DIR` / `DB_PATH` | Web 模式默认 `./data/thickearth.db`；桌面模式落在系统用户数据目录 |
| `PUBLIC_ORIGIN` | Web 部署时填对外域名，用于 CSRF Origin 校验 |
| `COOKIE_SECURE` | Web 模式走 HTTPS 时设为 1 |
| `THICK_EARTH_AI_MOCK` | 设为 1 时用内置 mock 提供方，不联网也能演示 AI 流程 |

桌面版另有 Electron 外壳：`electron/main.js` 起同进程内服务再开窗口。注意仓库不附带安装包，Electron 也不是本仓库的依赖——想用外壳得自己装 Electron（`npx electron .`）；`npm start` 再打开打印出来的地址则只要 Node 就行。

### 更新已安装的桌面版

安装目录下的 Electron 会优先加载 `resources/app.asar`，没有 asar 时退回 `resources/app/` 目录。所以改完源码要让它生效，最省事的做法是把源码目录放进去：

```bash
APP="$LOCALAPPDATA/Programs/ThickEarth/resources"
cp -p "$APP/app.asar" "$APP/app.asar.bak"      # 先留一份原包，回滚就是改回名字
mv "$APP/app.asar" "$APP/app.asar.disabled"    # 让 Electron 找不到 asar
mkdir -p "$APP/app"
for d in desktop electron server shared web; do cp -r "$d" "$APP/app/"; done
cp -p package.json "$APP/app/"
```

之后重启桌面程序即可。回滚：删掉 `app/`，把 `app.asar.bak` 改名回 `app.asar`。

桌面版数据库在 `%LOCALAPPDATA%\ThickEarth\data\thick-earth.db`（不是 `%LOCALAPPDATA%\ThickEarth\thickearth.db`，后者是 `npm start` 留下的）。

---

## 架构

```
shared/            前端后端共用，纯函数、无 IO
  rules.js         规则引擎：建局、合法性、落子与回合记账、连六判定、结果
  analysis.js      赛后分析：重放、棋型评估、关键节点、弱点、建议
  ai.js            本地棋型 AI（候选点剪枝 + 威胁排序，确定性）
  agent-protocol.js  LLM 提示词构造 + 严格响应解析（落子 / 教练报告 / 追问）

server/
  index.js         启动入口，读环境变量
  app.js           HTTP 应用工厂：路由、鉴权、错误映射
  games.js         对局服务：建局、加入、提交、AI 轮转、视图投影
  agent-seats.js   Agent 座位令牌 + 超时兜底调度
  ai-settings.js   AI 提供方配置与配额
  ai-provider.js   OpenAI 兼容 Chat Completions 适配器
  coach.js         赛后报告与追问
  db.js            SQLite 仓储层
  realtime.js      SSE 广播
  export.js        棋谱导出
  playtest.js      试玩数据统计与 CSV

web/               原生 ESM，无构建步骤
  js/core/         路由、状态、i18n、DOM 工具
  js/game/         19×19 棋盘渲染（星位、获胜连线高亮、键盘可达）
  js/views/        各页面（建局、对局、回放、历史、分析、规则、设置）
```

**持久化设计**：一局存的是「初始状态 + 有序动作日志」，当前状态、结果、指标都是物化出来的派生数据。所以任何一局都能从日志完整重放，分析结果可复核，教练报告也被约束只能引用日志里存在的东西。

核心数据表：`games`（含 `initial_state` / `current_state` / `seats` / `result` / `metrics`）、`actions`、`users`、`ai_usage`、`coach_reports`。

---

## 为什么单点威胁赢不了

一回合两子，对手可以用第一子挡掉你唯一的威胁，剩下的子继续进攻。所以真正决定胜负的是**双威胁**：同时造出两条都需要应的线，一回合挡不完。

本地 AI 的评分就建立在这一点上——沿四个方向算 run length × 开放端数，连五 / 活四 / 冲四 / 活三分档加权，再对对手的威胁做衰减惩罚（`DEFENCE_WEIGHT`）。分析引擎用同一套棋型定义，但每子贡献封顶在活四，避免一着五连把 swing 值全部顶到上限。

---

## 三种 AI 形态

| 形态 | 怎么用 | 特点 |
|---|---|---|
| 本地棋型 AI | 座位 `kind=ai, engine=local` | 进程内，毫秒级出招，离线可用，确定性（无随机） |
| LLM 座位 | 座位 `kind=ai, engine=llm`，设置里填 provider | 每手构造提示词（规则摘要 + 棋盘图 + 剩余子数 + 合法点位），要求返回裸坐标；非法动作重试一次后回退本地 AI |
| 外部 Agent | 座位 `kind=agent` | 服务端**不代打**，等外部提交；令牌 + 回合契约，适合接任意 Agent 运行时 |

填 API Key 的位置在「设置 → AI 提供方」，支持 DeepSeek、阿里百炼、智谱、硅基流动、OpenAI 和自定义 OpenAI 兼容端点。注意：填完 Key 还要在开局时把座位引擎选成 `LLM` 才生效。

LLM 座位**一回合只请求一次、一次要回两颗子**，并有 2.5 秒硬超时（可用 `THICK_EARTH_LLM_MOVE_TIMEOUT_MS` 调整）、每局 40 次 / 每月 500 次上限。超时、空响应、格式不对一律立刻回退本地 AI——棋力被刻意放在响应速度之后。DeepSeek 上落子请求会关闭默认开启的思考模式，否则输出预算会被思维链吃光。

**服务器共享 LLM（可选）**：在你的网站账号中配置并启用提供方，然后在服务器设置 `AI_SHARED_LLM=1`，并用 `AI_SHARED_USER_ID=<你的账号 ID>` 或 `AI_SHARED_USER_EMAIL=<已注册邮箱>` 明确指定共享来源。**个人配置优先**，无个人可用配置的登录用户可以借用共享模型下棋；共享 Key 不下发浏览器。共享调用计入提供账号的每局 / 每月额度，并受每位借用者额度和并发限制。Web 模式不会自动选择访客的 Key。完整步骤见 [共享与安全说明](docs/SECURITY-AND-SHARED-LLM.zh-CN.md)，Agent 评价见 [接入评价](docs/AGENT-EVALUATION.zh-CN.md)。

**云端 LLM 知道规则吗？** 知道，但只在你开 `LLM` 引擎的座位生效。规则不是靠模型"记住"的：每一手都由服务端把规则摘要、当前棋盘、本回合还差几子、全部合法点位重新拼进提示词，再严格解析返回的坐标。解析失败或坐标不合法就重试一次，仍失败则回退本地 AI——所以模型记不记得六子棋规则，都不影响对局合法性。

---

## 接入自己的 Agent

三步，全程 HTTP，不限语言。

```bash
# 1. 建一局，0 号座位留给 Agent（mode=arena 时两个座位都必须是 agent 或 ai）
curl -s -X POST http://127.0.0.1:7788/api/games \
  -H 'Content-Type: application/json' \
  -d '{"mode":"arena","playerCount":2,
       "seats":[{"kind":"agent","name":"My Agent"},
                {"kind":"ai","engine":"local"}]}'

# 2. 领令牌（原文只返回一次）
curl -s -X POST http://127.0.0.1:7788/api/games/<gameId>/seats/0/token

# 3. 拉局面 / 落子（一次落一子；本回合还差几子看 stonesRemainingThisTurn）
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:7788/api/agent/game
curl -s -X POST -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"turnId":12,"action":{"type":"place","x":9,"y":9}}' \
  http://127.0.0.1:7788/api/agent/actions
```

参考实现（无依赖，可直接跑完整一局）：

```bash
node agents/example-client.mjs http://127.0.0.1:7788           # Agent vs 本地 AI
node agents/example-client.mjs http://127.0.0.1:7788 --arena    # 双 Agent 互斗
```

已经在浏览器里开好了对局？去「Agent 座位」面板复制令牌，把外部进程接到那个座位上——`attach-agent.mjs` 是 60 行的起步模板，你只需要写 `chooseMove()` 一个函数：

```bash
node agents/attach-agent.mjs <gameId> <token> http://127.0.0.1:7788
```

完整契约见 [`docs/AGENT-SEAT.md`](docs/AGENT-SEAT.md)：鉴权、事件、错误码、超时语义。

---

## API 一览

| 分组 | 端点 |
|---|---|
| 元信息 | `GET /api/config`、`GET /api/health` |
| 账号（Web 模式） | `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me` |
| 对局 | `GET/POST /api/games`、`POST /api/games/join`、`GET/DELETE /api/games/:id`、`POST /api/games/:id/start`、`POST /api/games/:id/actions`、`GET /api/games/:id/events`（SSE） |
| 分析与教练 | `GET/POST /api/games/:id/analysis`、`GET/POST /api/games/:id/coach`、`POST /api/games/:id/coach/messages`、`POST /api/games/:id/hardest-decision` |
| 导出 | `GET /api/games/:id/export?format=json\|md\|txt`、`GET /api/playtest/export?format=csv` |
| AI 配置 | `GET/PUT /api/ai/settings`、`POST /api/ai/test`、`DELETE /api/ai/key` |
| Agent 座位 | `POST /api/games/:id/seats/:seat/token`、`GET /api/agent/game`、`POST /api/agent/actions`、`GET /api/agent/events` |

错误统一为 `{"error":{"code":"...","message":"..."}}`。

---

## 测试

```bash
npm test          # 测试与安全回归
npm run smoke     # 起真服务跑一局，再校核导出、分析、统计与静态资源
```

`test/rules.test.mjs` 覆盖连六判定、首手一子、回合内两子记账、终局后拒绝落子、坐标往返。
`test/analysis.test.mjs` 覆盖分析输出契约、漏杀/漏挡识别、进行中局面、损坏日志截断。
`test/ai.test.mjs` 覆盖 AI 合法性、确定性、能抓住连六机会。
`test/agent-seat.test.mjs` 覆盖令牌缺失/伪造/跨局隔离、`STALE_TURN` 拦截、超时兜底、Agent 打完整一局、arena 双 Agent、各模式座位组合校验。
`test/web.test.mjs` 是前端守卫：中英文案键必须一一对应、`t()` 引用的键必须存在、视图里不能残留扎营/召回/弃权词汇、棋盘必须是 19 路且带星位与获胜连线。

---

## 几个刻意的取舍

**为什么用 `turnId` 而不是裸提交**：Agent 是异步的，可能超时重试、可能两个 worker 抢同一个令牌。用 `state.seq` 当回合号，提交不匹配就 `409 STALE_TURN`，宁可让它重读局面，也不让一招落在它没见过的棋盘上。

**为什么一回合仍拆成两次决策**：规则要求「每次决策对应一颗落子」，所以引擎用 `placedThisTurn` 记账，落满 2 子才换手。LLM 座位改成一次调用把两颗子一起要回来，再逐颗校验落盘——决策边界不变，网络往返减半。

**为什么 LLM 落子偏速度而非棋力**：落子请求在 DeepSeek 上带 `thinking: {"type": "disabled"}`，输出预算 256 token，硬超时 2.5 秒（可用 `THICK_EARTH_LLM_MOVE_TIMEOUT_MS` 调整）。超时、空响应、格式不对，一律本地 AI 接管。棋力被刻意放在响应速度之后；排查提供方时开 `THICK_EARTH_LLM_DEBUG=1` 可打印原始回复。

**为什么有超时兜底**：外部进程会挂。没有兜底，一个卡死的 Agent 能把整局冻住。到期用本地 AI 代打并记 `fallbackCount`，评测时可以据此剔除被污染的局。

**为什么没做"超时判负"**：规则里没有"淘汰座位"这个概念，硬加等于产品里同时存在两套规则。宁可让数据可清洗，也不让规则分叉。

**为什么零依赖**：`node:sqlite`、`node:crypto`、`node:http` 够用了。没有 `node_modules`，没有构建步骤，克隆下来就能跑，也给评测环境省事。代码也不依赖本地长连接或后台常驻服务——服务端是一个普通 HTTP 进程，Agent 侧是轮询式客户端，可以直接迁移到评测环境。

---

## 已知限制

- `online` 模式把座位绑在用户会话上，不支持 Agent 令牌。
- API 不返回 CORS 头，浏览器里跑的 Agent 会被同源策略拦住；Agent 请作为本地进程运行。
- AI 提供方的响应格式限定 OpenAI 兼容的 Chat Completions。
- 本地 AI 是棋型启发式，不是搜索型引擎；强于随机但打不过正经六子棋程序。
