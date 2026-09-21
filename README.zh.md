# 子代理独立读写权限（subagent-permissions）

**给 dsh 的主代理加一对参数，让它在派活时顺手规定每个子代理的读写权限。子代理改不了自己的权限，主代理也不能借派活给子代理放权。**

- 形态：**一个插件 + 一处对 dsh 成品包的代码补丁**（补丁有独立备份与一键还原）
- 现状：**只做在 `E:\dsh\workspace\dsh\subagent-permissions\`，尚未装到你正在跑的 dsh 上**
- 生效条件：执行安装 + **重启 dsh 进程**（`patchReload` 不会重新 import 模块，改代码必须重启）

---

## 1. 它解决什么问题

dsh 的沙箱权限模型有三个事实：

1. **写权限的边界就是会话的 `cwd`**。`dsh-sandbox-policy.resolve()` 取的是
   `session.header.cwd`，而且 **`SessionHeader` 在会话创建那一刻就冻结了**，之后无法改写。
2. **模式（`read-only` / `workspace-write` / `danger-full-access`）是逐会话的**，以
   `sandbox/mode` 事件记录在该会话自己的日志里。
3. **子代理默认全盘继承父会话**：`cwd` 抄父会话的，模式抄父会话的显式覆盖（没有就落到部署默认）。
   而 `subagent` 工具过去只允许逐次覆盖 provider / model / reasoning-effort / max-tokens，
   **没有任何权限参数**。

所以过去只有两个极端可选：全部子代理继承（等于没有隔离），或者在部署层把模式调紧（一刀切，所有会话一起受影响）。
而 `agent/created` / `session/created` 事件是在**发布之后**才触发的，一个纯插件无法回头改会话头 —— 这就是为什么本方案必须动一小块 dsh 代码。

**本方案补上的第三档：** 主代理在**每一次**派活时单独指定这个子代理的权限范围。

---

## 2. 怎么用（给模型侧的接口）

派活时多一个可选对象 `delegate_permissions`（**省略即完全继承，与加装前行为一致**）：

```jsonc
// 只读侦察：子代理能读、能跑只读命令，写一律被拒
subagent({
  description: "审计依赖",
  prompt: "……",
  delegate_permissions: { "sandbox_mode": "read-only" }
})

// 隔离施工：子代理的会话工作区就是它自己的目录，只能写这里
subagent({
  description: "生成资源",
  prompt: "……",
  delegate_permissions: {
    "sandbox_mode": "workspace-write",
    "writable_root": "E:\\dsh\\workspace\\flowerdream\\subagents\\assets-1"
  }
})
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `sandbox_mode` | `"inherit"`（默认）/ `"read-only"` / `"workspace-write"` / `"danger-full-access"` | 子会话的文件效果模式。`inherit` 保留主代理当前模式；`read-only` 拒绝一切文件写入（**平台临时目录除外**，见 3.4）；`workspace-write` 把写入限制在 `writable_root` 之下（外加平台临时目录）；`danger-full-access` 只允许在**主代理自己也是** `danger-full-access` 时使用。 |
| `writable_root` | 绝对路径字符串（可选） | 变成子会话的工作区，同时也是它 `workspace-write` 的边界。**目录不存在会自动创建**；相对路径、过宽的路径（如盘根）、不在主代理可写范围内的路径都会被拒绝。省略 = 继承父会话工作区。 |

**子代理侧**：它读到的运行时上下文里会多一句说明，写清"本次委派由谁固定了什么权限"，例如

```
…你是一个被委派的子代理……你的权限范围在启动时就被固定……
你的文件权限范围由委派方指定：sandbox mode "workspace-write"；
你的可写工作区根是 "E:\\…\\subagents\\assets-1"，因此在 workspace-write 模式下
你只能修改它下面的文件，外加平台临时目录。
```

---

## 3. 权限模型（这是本方案的核心取舍）

### 3.1 单调收窄：只能给小，不能给大

子代理的最终模式 = `min(主代理当下模式, 请求的模式)`。

| 主代理当下 | 允许派发的模式 |
|---|---|
| `read-only` | `read-only`（其余一律拒绝） |
| `workspace-write` | `read-only`、`workspace-write`、`inherit` |
| `danger-full-access` | 以上全部，外加 `danger-full-access` |

显式请求 `danger-full-access` 而父会话不是该模式时，**直接报错**，不做静默降级 ——
静默降级会让主代理误以为“我已经放权了”。

### 3.2 `writable_root` 必须落在主代理自己的可写范围内

`workspace-write` 下的可写根 = 会话 `cwd` + 平台临时目录（由 `dsh-sandbox.writableRoots()` 统一推导）。
请求的 `writable_root` 必须落在其中之一，否则报错：

> `delegate_permissions.writable_root "…" is outside every root this session may write under …`

理由：如果允许主代理把子代理的工作区指到自己都写不了的地方，那么“派子代理去写”就成了一条**绕过自身沙箱**的路径。这条检查同时也保护了 Windows 受限令牌（ACL）执行器 —— 它按会话工作区授权，指向外部目录的子会话说不定连自己都无法写。

### 3.3 固定即不可变

权限在**子会话被创建的那一瞬间**写死（`cwd` + 一条 `sandbox/mode` 事件），此后：

- 子代理自己无法放宽（`subagent:delegation` 上下文已明确告知，且沙箱层面的提权需要用户审批）；
- **主代理也无法通过后续交互改动它** —— 对可续期子代理（`continuable`）执行 `send_message` 不会改变其权限；
  只有 `sandbox/mode` 事件与创建时的 `cwd` 是权威，而日志里那条事件只有在**创建窗口内**才能追加。

> 换句话说：续期子代理的权限在它诞生时就定稿了；需要另一套权限就派一个新的。

### 3.4 明确不设防的地方（请知情）

- **沙箱只管写、不管读**。`read-only` 子代理**仍然能读**主工作区的所有文件（这通常正是想要的：只读侦察）。
- **平台临时目录始终可写**（`read-only` 也一样，因为临时目录不在 `workspace-write` 的授权范围内，而是执行器另外授予的）。别把临时目录当作可信区域。
- **文件工具（read/write/edit）是"信任代码里的策略闸"，不是内核边界**；真正拦子进程写的是 shell 执行器那条线。本方案不声称能挡住恶意代码，它挡的是"代理越权"。
- 若装配里没有挂沙箱执行器（例如只挂了 `dsh-fs-local` 而没有 `ctx.sandboxPolicy`），则**没有任何东西拦写**，本方案只是把模式写进会话日志。

---

## 4. 工作原理（两部分的分工）

```
主代理调用 subagent(delegate_permissions)
        │
        ▼
[补丁] dsh-tool-subagent
  · 校验、收窄、拒绝越权请求（resolveDelegatedPermissionsForCall）
  · 在一层 AsyncLocalStorage 载体上绑定决定（bindDelegatedPermissions）
        │
        ▼  载体：globalThis[Symbol.for("dsh.subagent-permissions.carrier")]
        │        = { storage: AsyncLocalStorage, sink: 审计回调 }
        ▼
[补丁] dsh-subagent（子会话尚未发布的那个窗口）
  · childSessionMeta()        → 用 writable_root 作为子会话 cwd
  · applyChildComposition()   → 追加 sandbox/mode 事件 + 向子代理说明权限
        │
        ▼
dsh-sandbox-policy.resolve() 读出模式与 cwd ⇒ 子代理的每一次写操作都被这条边界约束

[插件] dsh-subagent-permissions
  · 认领载体上的 sink ⇒ 这是"是否向模型暴露 delegate_permissions"的总开关
  · 审计：每次委派往 JSONL 追加一条记录
  · 策略：可选的 writableRootBase，把可写根再收进一个部署指定的子树
  · tools/execute 钩子：派发前做上面这两件事
```

**为什么不能只写插件？** 因为子会话的 `cwd` 只在 `childSessionMeta()` 里被决定，而那是
`@deepseek-ai/dsh-subagent` 的模块私有函数；且这个决定必须发生在会话**发布之前**。
插件能拿到的一切扩展点（`agent/created`、`session/created`、`tools/*`）都在发布之后或拿不到子会话头。
所以：**补丁负责两根无法从外部触及的线，插件负责其余全部策略。**

### 补丁范围（三个包、五个文件，全部是纯增量单点替换）

| 包 | 文件 | 改动 |
|---|---|---|
| `@deepseek-ai/dsh-subagent` | `lib/index.js` | 6 处：加 `AsyncLocalStorage` 导入；约 20 行载体；`childSessionMeta` 一行选 cwd；`applyChildComposition` 用**传入的子会话**追加事件并改写提示；`materializeTracked` 调用点补上子会话参数；能力门槛加一条注释性豁免 |
| `@deepseek-ai/dsh-subagent` | `lib/types/child-agent.js` | 4 处：与上一个文件同构（`dsh-tool-subagent-control` 会经 `dsh-subagent/internal` 加载这一层） |
| `@deepseek-ai/dsh-subagent` | `lib/types/continuation-activation.js` | 1 处：调用点补上子会话参数 |
| `@deepseek-ai/dsh-tool-subagent` | `lib/index.js` | 8 处：加导入；约 110 行校验/收窄/绑定辅助函数（**已导出**，便于离线测试）；参数表；`execute` 内取决定；三处调用点包上载体绑定；导出语句 |
| `@deepseek-ai/dsh-subagent-in-process-driver` | `lib/index.js` | 1 处：`subagent` 工具实际走的一次性创建路径，调用点补上子会话参数 |

改动全部是**单点字面量替换**，锚点不匹配就**报错退出**（半途打补丁比不打更糟）；不删原逻辑、不改原语义。

> `applyChildComposition` 新增了第 4 个参数（子会话）。这不是风格选择：子代理的作用域上下文**没有 `agent` 属性**，
> 早期版本写成 `childCtx.agent.session` 会在真实运行时报
> `cannot get property "agent" without inject`（离线 mock 当年恰好提供了 `agent`，所以没抓到 —— 现在测试用的
> 上下文是 Proxy，访问任何真实上下文没有的属性都会抛错）。缺失子会话时函数**直接报错**，绝不静默放行。

---

## 5. 安装、生效与还原

### 5.1 安装

```powershell
cd E:\dsh\workspace\dsh\subagent-permissions

# 先看会改什么（默认就是干跑，不动任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1

# 离线自检：锚点校验 + 26 项行为测试（也不动任何东西）
node selfcheck.mjs
# 等价于 installer 的 -Test，外加补丁文件语法与插件形态检查
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Test

# 真正安装（补丁 + 插件 + 挂载）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Apply
```

安装器做的事：

1. 定位所有可能被加载的 `@deepseek-ai/dsh-subagent` 安装点，逐个打补丁（打之前先把原始文件存进
   `backup\<包名>-<版本>\`，**只在首次打补丁时存，绝不覆盖已有备份**）；
2. 把插件复制到 `~\.dsh\profiles\web\node_modules\dsh-subagent-permissions`；
3. 在 `~\.dsh\profiles\web\cordis.patch.yml` 追加挂载块（先备份该文件）；
4. **不做**其它任何事。`-Apply` 之外的所有模式都不改文件。

### 5.2 生效：必须重启

**改完代码必须重启 dsh 进程。** `cordis-plugin-loader` 只在 entry 的 `name` 变化时才重新 `import`，
所以挂载行会实时重放，但**模块代码不会**。判断是否真的重载了，看插件日志里这行是否重新出现：

```
subagent-permissions: per-subagent file permissions are ON (…)
```

### 5.3 校验

```powershell
# 静态体检：两个包是否已打补丁、插件是否就位、挂载是否存在
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Verify
```

### 5.4 还原

**dsh 起不来时，跑这一条**（按正确顺序完成还原，两步都幂等，缺挂载/缺插件/缺备份只会报告不会失败）：

```powershell
# 先看会做什么（不改任何文件）
powershell -NoProfile -ExecutionPolicy Bypass -File .\revert-subagent-permissions.ps1 -DryRun

# 真正还原：先卸载插件与挂载行，再从 backup\ 还原全部 5 个文件
powershell -NoProfile -ExecutionPolicy Bypass -File .\revert-subagent-permissions.ps1

# 重启 dsh 后确认
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Verify
# 期望：0/5 patched、plugin MISSING、mount MISSING
```

也可以只用细粒度开关（`revert-subagent-permissions.ps1` 就是按这个顺序调它们）：

```powershell
# 只卸载插件（挂载行 + 插件目录），保留代码补丁
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Remove

# 只把 5 个成品包文件恢复成原始文件（插件仍挂着，但会自检失败并只记一条警告）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Restore
```

还原后同样需要重启 dsh。

> ⚠️ **dsh 升级会覆盖补丁**。升级后重新跑 `-Apply` 即可；如果新版本的代码变了导致锚点失配，
> 补丁脚本会拒绝执行并指名是哪个锚点 —— 那时按提示重新取锚点，不要强改。

---

## 6. 插件配置项

挂在 `cordis.patch.yml` 里的 entry config：

| 键 | 默认 | 含义 |
|---|---|---|
| `delegatePermissions` | `true` | 总开关。设为 `false` 时不认领 sink，模型侧**看不到** `delegate_permissions` 参数（工具描述里不会出现）。 |
| `auditLog` | `true` | 是否写审计 JSONL。 |
| `auditFile` | `<ctx.baseDir>/subagent-permissions.audit.jsonl` | 审计文件路径。安装器默认写成 `~\.dsh\subagent-permissions.audit.jsonl`。 |
| `writableRootBase` | 不设 | 部署级额外约束：所有派发的 `writable_root` 必须落在该目录之下（例如统一收进 `…\subagents\`）。不设则只要求落在主代理自己的可写根内。 |
| `toolName` | `subagent` | 若该工具被改名，插件据此识别要拦截的调用。 |

审计记录两种形态，都带 ISO 时间戳：

```jsonc
// 插件在派发前记录（模型请求了什么）
{"at":"…","delegatingSession":"…","tool":"subagent","label":"审计依赖","requested":{"sandbox_mode":"read-only"}}
// 补丁在决定生效时记录（实际给了什么）
{"at":"…","applied":true,"delegatingSession":"…","sandboxMode":"read-only","writableCwd":null}
```

---

## 7. 装机后的验收清单（建议照做一遍）

1. **只读子代理确实写不了，但读得到**
   派一个 `sandbox_mode: "read-only"` 的子代理，让它**读**一个探针文件、再**写**它。
   期望：读到 marker；写入被拒并收到 `[sandbox: file access denied under read-only mode]`；
   写入前后探针文件的 sha256 **不变**。
2. **独立工作区确实生效**
   派一个 `writable_root` 指向某目录的子代理，让它写一个相对路径文件，并再试写一个**范围外**文件。
   期望：子代理的会话工作区（策略行/ shell cwd）就是该目录；文件落在那里面；
   范围外写入被拒；会话日志里子会话的 header `cwd` 就是该目录。
3. **越权被拒**
   主代理当前是 `workspace-write` 时请求 `sandbox_mode: "danger-full-access"`。
   期望：**在子代理被创建之前**工具调用就失败，报 `would WIDEN the child`。
4. **范围外的可写根被拒**
   请求 `writable_root` 指向工作区之外（例如用户主目录）。
   期望：同样在创建之前失败，报 `is outside every root this session may write under`。
5. **审计留痕**
   `Get-Content ~\.dsh\subagent-permissions.audit.jsonl` 应能看到**两类**记录：
   一条是插件记的"模型请求了什么"（含 `requested`），一条是补丁记的"实际给了什么"（含 `applied: true`）。

会话日志验证方式与既有习惯一致：`subagent-permissions` 的插件日志、以及子会话日志里的
`subagent/descriptor` / `sandbox/mode` 事件。读会话日志要注意它是**多帧 zstd**，
必须流式解码（用 `node inspect-session.mjs <会话目录>`，一次 `zstdDecompressSync` 只能读到头部）。

### 7.1 本机实测结果（2026-09-22，全部通过）

| 项 | 结果 |
|---|---|
| 只读子代理读探针 | `READ_OK: marker: ORIGINAL-CONTENT-9F3A2C` |
| 只读子代理写探针（文件工具） | `[sandbox: file access denied under read-only mode]` |
| 只读子代理写探针（shell） | 被拒（ACL：`对路径…的访问被拒绝`） |
| 探针 sha256 | 三次验证后仍为 `C1FC6F4F…F441B`（未变） |
| 子代理自述策略 | `Current DSH file policy: read-only.` |
| 子代理自述委派范围 | `…fixed by the delegating agent: sandbox mode "read-only"; your session workspace is the inheriting workspace.` |
| 独立工作区 | 子代理 WORKSPACE 与 SHELL_CWD 均为指定 `writable_root`；`inside.txt` 落在其中 |
| 范围外写入 | `[sandbox: file access denied under workspace-write mode]`，文件未创建 |
| 越权请求 | 创建前失败：`would WIDEN the child beyond this session's "workspace-write" mode` |
| 范围外可写根 | 创建前失败：`is outside every root this session may write under` |
| 审计 | 每个带参数的派活产生 2 条记录（`requested` + `applied: true`） |
| 会话日志 | 子会话独立目录 `--E-dsh-workspace-dsh-…-verify-ws-probe--`，header `cwd` = 指定可写根 |

> 读是**不受限**的：沙箱只围写（这正是"只读侦察"可用的原因）。验收时若子代理声称"读也被拒"，
> 先让它**只做一步读**再判断——本机出现过一次由模型自身指令遵循导致的假报，单独复测即通过。

---

## 8. 目录内容

```
subagent-permissions\
├─ README.zh.md                        ← 本文
├─ LICENSE                             MIT
├─ package.json                        工程元数据 + npm scripts（check/generate/test/selfcheck）
├─ selfcheck.mjs                       一键离线自检（锚点 + 语法 + 真模块行为 + 审计链 + 插件形态 + key 一致性）
├─ install-subagent-permissions.ps1    安装 / 校验 / 还原（默认干跑，-Apply 才动手）
├─ revert-subagent-permissions.ps1     ★ 出问题时跑这一条：按正确顺序一键还原（-DryRun 可预演）
├─ patch.mjs                           补丁生成器（单点字面量替换，锚点失配即报错）
├─ dsh-subagent-permissions\           插件包（挂进 profile 的那一半）
│  ├─ package.json
│  └─ lib\index.js                     审计 + writableRootBase 策略 + 总开关 + tools/execute 钩子
├─ patched\                            生成的补丁后文件（安装时现场重生成；仓库保留便于审阅）
│  ├─ dsh-subagent\lib\index.js
│  ├─ dsh-subagent\lib\types\child-agent.js
│  ├─ dsh-subagent\lib\types\continuation-activation.js
│  ├─ dsh-tool-subagent\lib\index.js
│  └─ dsh-subagent-in-process-driver\lib\index.js
├─ backup\                             ★ 原始文件备份（还原用的就是这里）
│  ├─ dsh-subagent-0.1.5-rc.2\lib\index.js
│  ├─ dsh-subagent-0.1.5-rc.2\lib\types\child-agent.js
│  ├─ dsh-subagent-0.1.5-rc.2\lib\types\continuation-activation.js
│  ├─ dsh-tool-subagent-0.1.5-rc.2\lib\index.js
│  └─ dsh-subagent-in-process-driver-0.1.5-rc.2\lib\index.js
├─ test\
│  ├─ plant.mjs                        搭镜像树：让补丁后的包以"真模块"身份被 import
│  ├─ schema.test.mjs                  6 项 schema 测试（喂给 dsh 真实的 defineTool 校验器 + 2 条反向断言）
│  ├─ seam.test.mjs                    28 项权限行为测试（真实模块、真实 AsyncLocalStorage）
│  └─ audit.test.mjs                   7 项审计链测试（插件写入器 / 补丁→sink / tools/execute 钩子）
├─ probe-anchor.mjs                    锚点失配时打印真实字节，便于重取锚点
├─ probe-schema.mjs                    把每一种工具组合的 schema 跑一遍真实校验器（改 schema 后先跑它）
├─ probe-remotes.mjs                   推送前探测两个远程仓库是否可达
├─ inspect-session.mjs                 解压多帧 zstd 会话日志，抽取 cwd / sandbox-mode / 委派说明
├─ parse-check.ps1 / inspect-line.ps1  PowerShell 语法与逐字符排查（装机器排错用）
└─ test\.sandbox\                      plant.mjs 生成的临时镜像树（已 gitignore，可随时删）
```

`.gitignore` 排除了 `test\.sandbox\` —— 里面是**指向本机安装路径的目录联接**，绝不能提交。

**`backup\` 是最后一道保险**：即使补丁脚本本身坏了、或 dsh 升级把文件换掉，也可以直接从
`backup\<包名>-<版本>\<相对路径>` 手工覆盖回去。

---

## 8.5 维护（改动补丁或插件时的固定流程）

```powershell
# 1) 改 patch.mjs（或插件代码）后，先对照原始备份确认锚点仍然唯一
node probe-anchor.mjs

# 2) 从原始备份重新生成补丁产物
#    （装机后不要再对成品包跑 --check：它们已经被打过补丁，锚点当然不再匹配）
node patch.mjs --from backup --out patched

# 3) 全套离线自检（14 项检查）
node selfcheck.mjs

# 4) 若补丁有变：先还原再重新打（只改插件代码则可直接用 -FilesOnly）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Restore
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Apply

# 5) 重启 dsh（补丁与插件代码都不会热重载）
```

---

## 9. 常见问题

**Q：为什么不在部署层直接改模式，非要这么麻烦？**
部署层只能一刀切（所有会话同一个模式），而 `workspace-write` 的可写边界永远是**整个工作区**，挡不住子代理写 `project/` 之类的地方。逐会话收窄才是真正的隔离。

**Q：子代理能给自己放权吗？**
不能。模式写在它自己的会话日志里，但那条事件只有在**创建窗口内**才能追加；此后它想放宽要走沙箱提权，而提权需要用户审批，并且子代理的审批策略被固定为 `never`（继承 dsh 既有设计）。

**Q：能让子代理只读、但只读某个子目录吗？**
不能 —— 沙箱无读隔离，`read-only` 的语义是"不写"，不是"只看得见某处"。

**Q：`writable_root` 传了一个不存在但有权限创建的目录会怎样？**
会自动创建。传无权创建的路径、或已存在但不是目录的路径，会报错。

**Q：续期（`continuable`）子代理改权限？**
不支持也不打算支持：`cwd` 与初始模式在创建时定稿，`send_message` 不改权限。要换权限就新派一个。

**Q：卸载后会怎样？**
`-Remove` 只摘掉插件与挂载：模型侧不再看到 `delegate_permissions`，补丁仍在但因为没有 sink 而彻底静默（不会报错、不会改任何行为）。`-Restore` 再把成品包还原为原始文件。

---

## 10. 已知边界与后续可做

- **只有 in-process 子代理后端受此机制约束**（`spawn` / `fork`）。进程外后端（ACP / SDK / Codex / Claude Code）走的是另一套 `cwd` 配置，本方案未触及。
- **`tools/execute` 钩子只做拦截与审计**，不修改参数；真正的校验在 `dsh-tool-subagent` 的补丁里（因为那里才拿得到 `ctx.sandboxPolicy`）。
- 若上游将来把"逐子代理权限"做成原生能力，应当**撤掉补丁**，只保留插件里可复用的审计与 `writableRootBase` 策略。

### ★ 改 schema 时必读：`additionalProperties` 是启动级约束

dsh 的 author-time schema 校验器规定：**每个 `type: "object"` 节点都必须显式声明 `additionalProperties`（布尔值），嵌套对象同样适用。**
违反的后果不是"工具不好用"，而是**整个 `standard` preset 挂载失败、dsh 无法恢复会话**：

```
failed to apply loader entry tool-subagent-fork (@deepseek-ai/dsh-tool-subagent):
unsupported JSON schema: parameters.delegate_permissions.additionalProperties
must be explicitly true or false (…\dsh-agent-presets\presets\standard\agent.cordis.yml)
```

本项目为此有两道闸：

- `test\schema.test.mjs`：把 `delegate_permissions` 的字段交给**真实的 `defineTool`**（dsh 自己的校验器）编译，
  并含两条**反向断言**（故意删掉 `additionalProperties`，断言必须被拒），确保这条约束"真的在被校验"。
- `probe-schema.mjs`：把**每一种工具组合**（后台/前台、one-shot/continuable、含/不含模型选择、插件挂载/未挂载）
  的完整参数与输出 schema 都跑一遍真实校验器。**改完 schema 先跑它**，再谈重启。

---

## 11. 许可

MIT，见 `LICENSE`。

本仓库同时包含**对 dsh 成品包的补丁产物**（`patched\`）与**原始文件备份**（`backup\`）。
这些文件的版权属于上游 deepseek-ai / DeepSeek Harness 项目（MIT），此处仅作为可审计的补丁产物与还原依据保留。
