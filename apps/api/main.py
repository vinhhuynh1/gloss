import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import documents, study_spaces, suggestions

app = FastAPI(title="Study Notes Co-Editor API")

# Comma-separated, set per environment. Defaults to the Vite dev server so a
# fresh clone still works locally with no .env at all.
#
# allow_credentials stays off deliberately: auth is an Authorization: Bearer
# header, not a cookie, so there is nothing to gain and it would drag in the
# wildcard-origin restrictions.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(study_spaces.router)
app.include_router(documents.router)
app.include_router(suggestions.router)

# Mounted only when DEV_AUTH_SECRET is set, so a deployment that simply does
# not set the variable cannot expose a passwordless login by accident — there
# is no flag to get wrong, and auth.py refuses these signatures under the same
# condition. See routers/dev_auth.py.
if os.getenv("DEV_AUTH_SECRET"):
    from routers import dev_auth

    app.include_router(dev_auth.router)
    print(
        "WARNING: dev auth is enabled. POST /dev/login issues a valid token "
        "for any email address, with no password. Local development only."
    )


@app.get("/health")
def health():
    return {"status": "ok"}
