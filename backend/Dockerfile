FROM python:3.13.7-slim-bookworm

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
