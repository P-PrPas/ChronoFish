FROM node:22.14.0-alpine3.21 AS build

ARG VITE_API_BASE_URL=/api/v1

ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run check

FROM nginx:1.27.5-alpine3.21

ARG VCS_REF=unknown

ENV API_UPSTREAM=api \
    NGINX_ENVSUBST_FILTER=API_UPSTREAM \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginx/conf.d

LABEL org.opencontainers.image.title="KUVTH Zebrafish LIMS frontend" \
      org.opencontainers.image.description="KUVTH Zebrafish LIMS static React application" \
      org.opencontainers.image.source="https://github.com/P-PrPas/KUVTH-Zebrafish-LIMS" \
      org.opencontainers.image.revision="$VCS_REF"

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/templates/default.conf.template

RUN mkdir -p /tmp/nginx/conf.d /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp \
    && rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
    && chown -R nginx:nginx /tmp/nginx /usr/share/nginx/html

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
