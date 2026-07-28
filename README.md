# 传奇AI 授权后台 Pages

这个公开仓库只托管静态管理界面，不包含授权码、管理员口令或 RSA 私钥。

- Pages 地址：`https://admin.chuanqiai.xyz/admin/`
- 授权 API：`https://license.chuanqiai.xyz/api/`
- 原后台入口：`https://license.chuanqiai.xyz/admin`（由 Worker 跳转到 Pages）

授权数据存放在私有仓库 `chuanqiai-license-data`，动态接口由 Cloudflare Worker 提供。
