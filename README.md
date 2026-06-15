# r2-proxy

Cloudflare Worker 代理多个 R2 桶，URL 路径直接映射到对象 key，自动补 CORS、`Content-Type` 和基础缓存策略。

当前绑定的桶：

- `bluearchive`
- `dnf`
- `moshen`

默认桶：

- `dnf`

## 路由规则

- `GET /b/<alias>/<key>`：按桶别名读取对象
- `GET /<key>`：走默认桶 `dnf`
- `HEAD /b/<alias>/<key>`：只取响应头
- `OPTIONS`：CORS 预检
- `GET /health`：健康检查

当前别名和桶绑定关系：

- `bluearchive` -> `bluearchive`
- `dnf` -> `dnf`
- `moshen` -> `moshen`

示例：

```text
https://r2-proxy.<your-subdomain>.workers.dev/b/bluearchive/images/a.webp
https://r2-proxy.<your-subdomain>.workers.dev/b/moshen/assets/data.json
https://r2-proxy.<your-subdomain>.workers.dev/sprites/hero.png
```

最后一个例子没有写别名，所以会从默认桶 `dnf` 读取 `sprites/hero.png`。

## 本地开发

```bash
cd code/r2-proxy
npm install
npx wrangler login
npm run dev
```

本地启动后，可以直接访问：

```text
http://127.0.0.1:8787/health
http://127.0.0.1:8787/b/bluearchive/test.webp
http://127.0.0.1:8787/test.webp
```

## 部署

```bash
cd code/r2-proxy
npm run deploy
```

`wrangler.toml` 已经写入这三个桶名。如果之后要增减桶，只需要同时修改：

- `[[r2_buckets]]`
- `[vars]` 里的 `BUCKET_MAP`
- `DEFAULT_ALIAS`

## 上传示例

```bash
npx wrangler r2 object put bluearchive/test.webp --file ..\\..\\封面\\癌骑士.webp
npx wrangler r2 object put dnf/test.json --file .\\package.json
npx wrangler r2 object put moshen/test.txt --file .\\README.md
```

## 返回行为

- `json`：`Cache-Control: public, max-age=300`
- `html/js/css`：`Cache-Control: public, max-age=3600`
- 其他文件：`Cache-Control: public, max-age=31536000, immutable`
- 如果对象带有 R2 元数据，会优先复用
- 如果对象缺少 `Content-Type`，会按扩展名补一个常见值

## 健康检查返回示例

```json
{
  "ok": true,
  "service": "r2-proxy",
  "usage": [
    "GET /b/<alias>/<key>  按别名选桶",
    "GET /<key>            走默认别名"
  ],
  "defaultAlias": "dnf",
  "aliases": ["bluearchive", "dnf", "moshen"]
}
```
