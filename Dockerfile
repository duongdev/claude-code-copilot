FROM node:22-alpine

WORKDIR /app
COPY scripts/proxy.mjs scripts/proxy.mjs

EXPOSE 18080

CMD ["node", "scripts/proxy.mjs"]
