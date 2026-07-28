# Cloudflare Worker

Worker 保留原授权服务的接口：

- `GET /health`
- `GET /api/admin/licenses`
- `POST /api/admin/licenses`
- `POST /api/admin/licenses/disabled`
- `POST /api/admin/licenses/delete`
- `POST /api/admin/licenses/unbind`
- `POST /api/license/activate`
- `POST /api/license/verify`

Cloudflare 中需要设置三个 Secret：`GITHUB_TOKEN`、`ADMIN_TOKEN`、`LICENSE_PRIVATE_KEY_B64`。授权数据放在 GitHub 私有仓库，Secret 不进入 GitHub。
