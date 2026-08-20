# 两个人，原来是这样的

一个移动端优先的私密默契卡。一号创建房间后可立即填写，并用同一链接、二维码和加入码邀请多个二号；每个人独立发布自己的结果。

## 技术栈

- Astro + Preact 交互岛
- Cloudflare Workers 自定义入口
- D1：房间、参与者、轮次和答案
- Durable Objects + Hibernation WebSocket：房间内串行状态变更和实时通知
- 私有 R2：头像文件
- Zod、Vitest、TypeScript

## 本地运行

1. 安装依赖：`npm install`
2. 复制 `.dev.vars.example` 为 `.dev.vars`，将 `AUTH_PEPPER` 改为随机长字符串。
3. 启动：`npm run dev`

`npm run dev` 会先自动应用全部本地 D1 migrations，再启动 Astro。无需另外执行数据库命令。Astro 的开发服务器通过 Cloudflare Vite 集成提供本地 D1、R2 和 Durable Objects。

如果只想启动 Astro 而不检查数据库，可使用 `npm run dev:astro`；手动迁移命令为 `npm run db:migrate:local`。

## 部署

1. 在 Cloudflare 创建名为 `together-card` 的 D1 数据库和 `together-card-avatars` R2 bucket。
2. 将 `wrangler.jsonc` 中的 `database_id` 替换为真实 D1 ID。
3. 写入生产 secret：`npx wrangler secret put AUTH_PEPPER`。
4. 执行远程 migration：`npx wrangler d1 migrations apply together-card --remote`。
5. 构建并部署：`npm run build && npx wrangler deploy`。

生产环境应使用自定义域名，并在 Cloudflare Dashboard 中为 Worker 启用日志和告警。定时任务每天清理连续 30 天没有活动的房间及头像。

## 核心隐私规则

- 每个房间有且仅有一个一号，可以加入多个二号。
- 加入码、恢复码、浏览器席位令牌只以带 pepper 的哈希存储。
- 一号可以看到所有二号的身份与已发布结果；每个二号只能看到一号和自己，二号之间严格隔离。
- 发布前的状态接口只返回自己的草稿；个人发布后才向有权限的配对对象返回结果。
- 头像通过鉴权 API 读取，并遵循与结果相同的一号/二号可见性规则。
- 房间在 30 天无活动后由 Scheduled Worker 删除。

## 验证命令

```sh
npm run check
npm test
npm run build
```
