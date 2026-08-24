FROM python:3.13.7-slim-bookworm

ARG BUILD_DATE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="ChronoFish API" \
      org.opencontainers.image.description="ChronoFish cloning tracking API" \
      org.opencontainers.image.source="https://github.com/P-PrPas/ChronoFish" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    MIGRATIONS_DIR=/migrations/postgres

WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/src ./src
RUN python -m pip install --no-cache-dir . \
    && addgroup --system chronofish \
    && adduser --system --ingroup chronofish --no-create-home chronofish
COPY backend/db/migrations /migrations

USER chronofish
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["python", "-m", "chronofish", "healthcheck"]
ENTRYPOINT ["python", "-m", "chronofish"]
