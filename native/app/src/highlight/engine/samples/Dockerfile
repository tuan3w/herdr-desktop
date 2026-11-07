FROM node:22-alpine AS build
ARG VERSION=1.4.0
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# TODO: use a lockfile cache mount
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="ledger"
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
