# 万界 · 本机服务镜像
# 零依赖 Node 服务：托管前端 + 模型网关 + 数据落卷
FROM node:20-alpine

# 数据卷挂载点：db.json（记录）与 models.json（模型配置）都落这里
ENV WANJIE_DATA_DIR=/app/data \
    PORT=8787 \
    NODE_ENV=production

WORKDIR /app

# 只拷贝运行必需的两个文件；缓存依赖层不需要（零依赖）
COPY ai-proxy.js ./
COPY index.html ./

# 数据目录先建好并给 node 用户权限（以非 root 运行）
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 8787

USER node

# 优雅退出：容器停止时让 Node 正常收尾
STOPSIGNAL SIGTERM

CMD ["node", "ai-proxy.js"]
