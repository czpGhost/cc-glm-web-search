# cc-glm-web-search

<p align="center">
  <b>把你已有的 Z.AI（GLM）套餐额度，变成 Claude Code 的搜索与读取能力。</b><br>
  一次邮箱登录即可 —— 无需 API Key，无需另外计费。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success.svg" alt="Dependencies"></a>
</p>

> English version: [README.md](README.md)

## 为什么做这个

Claude Code 自带的 `WebSearch` / `WebFetch` 走 Anthropic 自己的后端。但很多人手上已经有
Z.AI 套餐额度 —— 那份额度本来就能跑 `web_search_prime` 和 `webReader`，只是没人把它接到
Claude Code 上。

这个 mod 做的就是这件事：**一次邮箱登录，把你的订阅额度变成 Claude Code 的搜索与读取能力**。
安装即生效，模型看到的工具是新的，背后的服务换成了 Z.AI。

## 功能特性

| 能力 | 说明 |
|---|---|
| **网页搜索** | `glm_web_search`，由 Z.AI 的 `web_search_prime` 服务端工具提供结果 |
| **网页读取** | `glm_web_fetch`，由 Z.AI 的 `webReader` 提取正文 |
| **视觉理解** | `glm_vision`（⚠️ 见下：ZCode 套餐网关不接收图片输入） |
| **零依赖** | 项目内没有 `node_modules`，装完即用 |
| **状态视图** | `/glm-status` 实时展示令牌、套餐、额度条与刷新周期 |

> ⚠️ **视觉能力的实测结论**：ZCode 套餐网关（`zcode.z.ai`）**不接受图片输入**，任何图片都返回
> `1210 图片输入格式/解析错误`（1×1 的 69 字节 PNG、外链图片、本地 base64 均实测失败）。
> 搜索与读取在同一个凭据下正常。`glm_vision` 仍然注册，但调用时会明确告知这一限制；
> 图片理解需要走 Z.AI 开放平台的 API Key（`api.z.ai`），本 mod 不使用该路径。

## 安装

在终端会话里：

```text
/plugin install cc-glm-web-search --marketplace czpGhost/cc-glm-web-search
```

然后在会话里登录一次：

```text
/glm login
```

浏览器会自动打开授权页，同意后令牌自动落盘。之后 `glm_web_search` 和 `glm_web_fetch` 就能用了。

开发时也可以直接从文件夹运行：

```bash
claude --plugin-dir /absolute/path/to/cc-glm-web-search
```

## 使用

```text
/glm login     # 登录（打开浏览器，授权后自动保存）
/glm logout    # 登出，清除本地凭据
/glm status    # 查看令牌、套餐与额度

/glm-login   /glm-logout   /glm-status      # 等价别名
```

每个子命令都注册了独立别名，因为命令菜单是按**名字**匹配的 —— 输入 `/glm-log` 时才会同时
提示 `login` 和 `logout`。

`/glm-status` 的输出行是**活的**：额度视图每秒重绘一次，重置倒计时逐秒跳动；`/glm login`
则在命令行里显示旋转指示与授权窗口倒计时，直到浏览器端同意为止。两个命令的输出都不占用
Claude Code 的底部提示栏，只在终端滚动区里显示。

## 截图

`/glm-status`：

```text
  ▸ token 30m · Start Plan · GLM-5.3 2.95M left · resets 2h 57m

      account  you@example.com
               token valid 30m

      plan     ZCode Start Plan [active] · ends 10-12 23:59 (3d 2h)
      quota    GLM-5.3        ██████████  98%  2.95M/3M   resets 2h 57m
      quota    GLM-5.3-Flash  ██████████ full      resets 2h 57m
      cycle    daily grant, refills at 00:00 Asia/Shanghai
```

额度条画的是**剩余量**。如果画已用量，一个全新账号会显示成空条 —— 读起来正好是反的。

## 配置

| 字段 | 默认值 | 用途 |
|---|---|---|
| `origin` | `https://zcode.z.ai` | 网关地址 |
| `model` | *（空，实时解析）* | 运行搜索/读取的模型 |
| `jwtEnv` | `ZAI_JWT` | 凭据引用名（直接读令牌的环境变量） |
| `vision` | `true` | 是否注册 `glm_vision` |

凭据解析顺序：`ZAI_JWT` → 本地令牌文件。删掉文件或执行 `/glm logout` 即可在本机撤销。

## 两点须知

**搜索结果有上限。** 一次 `web_search_prime` 上游最多返回 10 条。

**它完全没有依赖树。** `hooks/` 只通过注入的 `$` 接口访问 Claude Code（`$.fs`、`$.http`、
`$.clock`、`$.process`），除自身目录树和模块环境自带的 Web API 外不引用任何东西 —— 所以既
没有 `node_modules`，也没有 `dependencies`、`peerDependencies`，引擎升级时也无需跟着改。

## 开发

```bash
claude plugin validate /path/to/cc-glm-web-search
claude plugin test /path/to/cc-glm-web-search
```

`claude plugin validate` 按引擎的方式读取 manifest 与 hooks 模块源码，报告它 hook 了什么、调
用了什么。`claude plugin test` 让 `tests/*.test.ts` 跑在引擎本身上：协议解码、授权 URL 校验、
令牌存储的解析顺序、额度视图的格式，以及无凭据时的命令行为。

## 常见问题

**需要付费套餐吗？**
不需要。免费账号自带的体验套餐就能跑搜索和读取；视觉能力用的 Flash 模型也在同一份套餐里。

**凭据存在哪里？**
`~/.claude/cc-glm-web-search/token.json` —— 单个文件，不依赖任何环境变量。删掉它或执行
`/glm logout` 即可在本机撤销。

**无界面环境能用吗？**
可以。把令牌放进 `ZAI_JWT` 环境变量，三个工具即可无浏览器运行；只有实时状态栏与提示需要
终端。

**Z.AI 更新客户端后会不会失效？**
有可能 —— 网关会校验客户端指纹，新的 ZCode 版本可能需要同步更新身份常量
（`hooks/zai.ts`）。这里是一行改动，不涉及重构。

**视觉工具能用吗？**
不能 —— 不是这个网关。`zcode.z.ai` 对任何图片都返回 `1210`。工具仍注册，为的是让模型拿到明确
答复而不是沉默。见文首的说明；真正的图片理解需要 `api.z.ai` 开放平台的 Key。

**视觉工具会超时吗？**
以前会：宿主给单次 HTTP 请求 30 秒，而带思考的图片推理必然超过。现在视觉请求已关闭思考。

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=czpGhost/cc-glm-web-search&type=timeline&legend=top-left)](https://www.star-history.com/?repos=czpGhost%2Fcc-glm-web-search&type=timeline&legend=top-left)

## 免责声明

本项目仅用于技术分享与学习交流，请遵守相关服务条款与法律法规，自行承担使用风险。

## License

[MIT](LICENSE)
