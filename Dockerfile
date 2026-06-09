# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
# Defaults are for local; override env in the deployment (STORAGE_DRIVER=s3, etc.)
ENV STORAGE_DRIVER=s3 HOST=0.0.0.0 PORT=3000
CMD ["node", "dist/server.js"]
