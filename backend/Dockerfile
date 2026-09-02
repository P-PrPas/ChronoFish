FROM python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d

ARG BUILD_DATE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="KUVTH Zebrafish LIMS API" \
      org.opencontainers.image.description="KUVTH Zebrafish LIMS cloning tracking API" \
      org.opencontainers.image.source="https://github.com/P-PrPas/KUVTH-Zebrafish-LIMS" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    MIGRATIONS_DIR=/migrations/postgres

WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/constraints.txt ./
COPY backend/src ./src
RUN python -m pip install --no-cache-dir -c constraints.txt . \
    && addgroup --system chronofish \
    && adduser --system --ingroup chronofish --no-create-home chronofish
COPY backend/db/migrations /migrations

USER chronofish
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD ["python", "-m", "chronofish", "healthcheck"]
ENTRYPOINT ["python", "-m", "chronofish"]
