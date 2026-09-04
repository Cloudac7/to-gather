# To-Gather：两个人，原来是这样的

To-Gather 取 `together` 的谐音，是一个移动端优先的私密默契卡。一号创建房间后可立即填写，并用自动携带加入码的链接或二维码邀请最多 20 位二号；每个人独立发布自己的结果。双方发布后可以生成带二维码的 `1600 × 1600` PNG 和固定有效 30 天的公开结果快照。

首页可选普通默契卡或“一起听卡片”。创建者可以为每个自定义字段选择歌手、专辑、歌曲或纯自定义类型；歌手资料使用 TheAudioDB，专辑和歌曲使用 iTunes 香港目录。

## 技术栈

- Astro + Preact 交互岛
- Cloudflare Workers 自定义入口
- D1：房间、固定模板、参与者、轮次、答案和分享快照
- Durable Objects + Hibernation WebSocket：房间内串行状态变更和实时通知
- 私有 R2：头像、答案图片和分享海报
- Zod、Vitest、TypeScript

## 本地运行

1. 安装依赖：`npm install`
2. 复制 `.dev.vars.example` 为 `.dev.vars`，将 `AUTH_PEPPER` 改为随机长字符串。
3. 启动：`npm run dev`

`npm run dev` 会先自动应用全部本地 D1 migrations，再启动 Astro。无需另外执行数据库命令。Astro 的开发服务器通过 Cloudflare Vite 集成提供本地 D1、R2 和 Durable Objects。

如果只想启动 Astro 而不检查数据库，可使用 `npm run dev:astro`；手动迁移命令为 `npm run db:migrate:local`。

## 部署

1. 在 Cloudflare 创建名为 `to-gather` 的 D1 数据库和 `to-gather-media` R2 bucket。
2. 将 `wrangler.jsonc` 中的 `database_id` 替换为真实 D1 ID。
3. 写入生产 secret：`npx wrangler secret put AUTH_PEPPER`。
4. 执行远程 migration：`npx wrangler d1 migrations apply to-gather --remote`。
5. 构建并部署：`npm run build && npx wrangler deploy`。

生产环境应使用自定义域名，并在 Cloudflare Dashboard 中为 Worker 启用日志和告警。定时任务每小时检查并清理已过期分享；房间连续 30 天没有活动后也会删除。

## 图片与分享

- 创建者可在创建房间时修改主标题、副标题和九个字段标题；房间创建后模板固定。
- 一起听卡片的歌手搜索由 Worker 代理 TheAudioDB；专辑和歌曲由浏览器直接访问 iTunes 香港目录，避开 iTunes 对 Cloudflare 共享出口的限流。查询不区分大小写，输入至少两个字符后显示结果。
- 已发布内容可以撤回修改并重新发布；已经创建的公开分享仍是独立快照，不会被后续修改覆盖。
- 数据库只保存外部封面 URL 和商店详情 URL；封面展示和 Canvas 导出通过限定 TheAudioDB 与旧版 `mzstatic.com` 域名的同源代理完成，不复制到 R2。
- 搜索只提供音乐归属和封面，不抓取歌词或音频预览；歌词字段始终由用户自行填写。
- 九个答案字段各支持一张 JPEG、PNG 或 WebP。浏览器会纠正方向、将最长边压到 1600px，并转为约 700KB 以内的 WebP。
- 图片和文字可同时填写，文字可选；仍需上传头像，并至少填写一段文字或上传一张答案图片才能发布。
- 双方都发布后才能生成分享。预览只在浏览器本地生成，确认公开后才创建快照、二维码和海报。
- 一号可以分别与任意已发布二号生成卡片；二号只能生成自己与一号的卡片。双方独立管理各自创建的链接。
- 同一组有效分享默认复用，也可以主动生成新链接。每条链接从创建时起固定有效 30 天，访问不会续期。
- 分享页展示未截断的完整答案和图片，设置 `noindex, nofollow, noarchive`，并使用同一张方图作为 Open Graph 预览。
- 分享撤销或到期后，公开海报、完整快照及分享资源引用会被清理；原链接只显示对应状态。

## 核心隐私规则

- 每个房间有且仅有一个一号，最多加入 20 个二号。
- 加入码由房间 ID 和服务端 pepper 通过 HMAC 派生，数据库只保存其哈希；一号可凭已认证席位恢复。恢复码和浏览器席位令牌同样只以带 pepper 的哈希存储。
- 一号可以看到所有二号的身份与已发布结果；每个二号只能看到一号和自己，二号之间严格隔离。
- 发布前的状态接口只返回自己的草稿；个人发布后才向有权限的配对对象返回结果。
- 头像和答案图片通过鉴权 API 读取，并遵循与结果相同的一号/二号可见性规则。
- 普通发布仍只在房间参与者之间可见；生成公开分享前会再次预览并明确确认公开范围。
- 公开分享使用不可猜测的随机 ID，不暴露加入码、恢复码或参与者令牌。
- 多条分享通过资源引用表复用相同答案图片，避免重复存储。
- 房间在 30 天无活动后由 Scheduled Worker 删除。

## 验证命令

```sh
npm run check
npm test
npm run build
```
