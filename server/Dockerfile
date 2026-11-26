# Build from the repository root:  docker build -f server/Dockerfile -t miyar-server .
FROM node:22-slim
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/server.js server/schema.sql ./
COPY index.html ./public/index.html
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
