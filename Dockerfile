ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.mjs ./
COPY frontend ./frontend
COPY src/subscriptions/games.mjs ./src/subscriptions/games.mjs
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
WORKDIR /app
ARG ALPINE_MIRROR=
COPY requirements-parser.txt ./
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR%/}|g" /etc/apk/repositories; fi \
    && apk add --no-cache python3 py3-pip ffmpeg font-noto-cjk font-noto-emoji \
    && python3 -m venv /opt/link-parser
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN /opt/link-parser/bin/pip install --no-cache-dir -r requirements-parser.txt
ARG CHROMIUM_ALPINE_MIRROR=
RUN if [ -n "$CHROMIUM_ALPINE_MIRROR" ]; then sed -i "s|https://[^/]*/alpine|${CHROMIUM_ALPINE_MIRROR%/}|g" /etc/apk/repositories; fi \
    && apk add --no-cache chromium
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --from=frontend-build --chown=node:node /app/node_modules ./node_modules
COPY --from=frontend-build --chown=node:node /app/dist ./dist
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3080 DATA_DIR=/app/data LINK_PYTHON=/opt/link-parser/bin/python
EXPOSE 3080
CMD ["node", "--expose-gc", "src/server.mjs"]
