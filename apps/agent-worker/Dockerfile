# Python 3.11-slim to match apps/api, the same way apps/realtime matches Node 24.
FROM python:3.11-slim

# Unbuffered so the polling loop's output reaches the platform's log drain as
# it happens rather than when a buffer fills — this process logs rarely and
# would otherwise look dead for minutes at a time.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Weights are baked in below; keep the cache on the image rather than in a
    # home directory the platform may not persist between restarts.
    HF_HOME=/opt/hf \
    # Nothing here trains, and the download is large and slow.
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app

# CPU-only torch, installed BEFORE requirements.txt and deliberately.
# sentence-transformers depends on torch, and the default PyPI wheel bundles
# the CUDA runtime — roughly 2.5GB of nvidia libraries that cannot be used on
# a CPU host and push the image past what a small plan will build. Installing
# the CPU build first means the dependency is already satisfied when
# sentence-transformers is resolved, so pip never fetches the CUDA one.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch

# Copied before the source so a source-only change reuses both install layers.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the ~90MB of model weights into the image instead of downloading them
# on first use. Three reasons: a cold start would otherwise spend seconds
# fetching before it can embed anything; the download is an unauthenticated
# Hugging Face request, which is rate-limited and warns about it; and an
# ingest that fails because a third party is having an outage is a confusing
# way to discover the dependency exists. MODEL_NAME is duplicated here rather
# than imported because this runs before the source is copied — if it changes
# in embeddings.py, change it here too.
RUN python -c "from sentence_transformers import SentenceTransformer; \
SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

COPY . .

# No EXPOSE and no ${PORT}: this is not a server. It polls Postgres for queued
# uploads and agent requests and exits only on signal, so there is nothing to
# bind and nothing to health-check over HTTP — see railway.json, which has no
# healthcheckPath for that reason.
#
# Exec form so python is PID 1 and receives SIGTERM directly on redeploy. The
# loop does not install a handler, so it dies where it stands; that is safe
# because a row claimed by a killed worker is returned to the queue by
# reclaim_stale() rather than being lost.
CMD ["python", "worker.py"]
