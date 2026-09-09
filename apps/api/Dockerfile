# Python 3.11 matches the local toolchain, the same way apps/realtime's
# Dockerfile matches Node 24. psycopg[binary] ships manylinux wheels, so
# -slim needs no compiler.
FROM python:3.11-slim

# Unbuffered so uvicorn's logs reach the platform's log drain as they happen
# rather than when a buffer fills.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Copied before the source so a source-only change reuses the install layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Documentation and the local default only. EXPOSE has no runtime effect, and
# ${PORT} below wins wherever the platform injects one.
EXPOSE 8000

# Two things this line is carrying:
#
# WORKDIR stays the CWD, and it has to. main.py does `from routers import ...`
# — flat imports with no package above them and no __init__.py at this level —
# so the app only imports when the process starts here.
#
# `sh -c` rather than a bare exec form because ${PORT} has to expand, and the
# platform injects it. `exec` then replaces the shell so uvicorn is PID 1 and
# gets SIGTERM directly; without it sh holds PID 1 and swallows the signal.
# Same reasoning as the CMD comment in apps/realtime/Dockerfile.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
