# Build stage: pip and the npm cache stay here, out of the final image.
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
# From PyPI rather than apk, so yt-dlp is current. curl-cffi is needed for signed-out Instagram.
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --only-binary=:all: 'yt-dlp[default,curl-cffi]' \
 && /opt/yt-dlp/bin/pip uninstall --yes pip
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-alpine
RUN apk add --no-cache ffmpeg python3
COPY --from=build /opt/yt-dlp /opt/yt-dlp
# The web page listens only inside the container, where nothing can reach it, so it is off.
ENV PATH="/opt/yt-dlp/bin:$PATH" NODE_ENV=production PORT=off
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The WhatsApp login. A volume mounted here keeps it between restarts.
RUN mkdir -m 700 auth && chown node:node auth
USER node
CMD ["node", "src/bot.ts"]
