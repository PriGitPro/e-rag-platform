FROM python:3.12-slim

WORKDIR /app

# System deps: gcc for psycopg2 compilation, libpq-dev for pg client headers
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY apps/ingestion-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/ingestion-worker/src/ ./src/

WORKDIR /app/src
ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "worker.py"]
