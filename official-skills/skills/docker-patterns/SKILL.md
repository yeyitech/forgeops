---
name: docker-patterns
description: "Docker/Docker Compose 模式：多阶段构建、镜像瘦身、权限与安全、可复现开发环境与运行时诊断。"
---

# 执行准则

1. 镜像可复现：基础镜像要固定 major/minor（必要时固定 digest），避免漂移。
2. 最小权限：运行阶段尽量非 root；只暴露必要端口。
3. 镜像最小化：多阶段构建 + `.dockerignore`，减少 attack surface 与构建时间。
4. 配置外置：秘密与环境变量通过运行时注入，禁止写进镜像。

## Dockerfile 最小规范

- 使用多阶段构建（builder/runtime）
- 合理利用 layer cache（先拷贝 lockfile 再 install）
- 只复制必要文件到 runtime stage
- 运行阶段使用非 root 用户（如果可行）

## Compose（本地开发）最小规范

- 服务拆分清晰（app/db/cache）
- 明确 volumes（数据持久化）与 networks（服务发现）
- 为常见诊断留出入口（healthcheck、logs、端口映射）

## 常见诊断命令（证据）

- `docker build -t <name> .`
- `docker images | head`
- `docker run --rm -p ... <name>`
- `docker compose up -d && docker compose ps && docker compose logs --tail 200`

## 输出协议（建议）

1. `Build`: 构建命令与结果
2. `Run`: 启动方式与健康检查结果
3. `Size/Security`: 镜像体积变化与主要安全点（root/ports/secrets）

