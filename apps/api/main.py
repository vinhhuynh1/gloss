from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import documents, study_spaces, suggestions

app = FastAPI(title="Study Notes Co-Editor API")

# Local dev only — tighten this before deploying.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(study_spaces.router)
app.include_router(documents.router)
app.include_router(suggestions.router)


@app.get("/health")
def health():
    return {"status": "ok"}
