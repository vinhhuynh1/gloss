"""
Shared embedding model for both ingestion and retrieval.

ingest.py and agent.py both import from here deliberately. If the two ever
used different models, the vectors would be mathematically incompatible and
retrieval would quietly return nonsense rather than failing loudly — one of
the nastier bugs to notice in a RAG pipeline, because everything still
"works," it just returns irrelevant chunks.
"""
import threading

from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Must match the VECTOR(...) dimension in infra/init.sql and the Vector(...)
# column in apps/api/models.py. Change one, change all three.
EMBEDDING_DIM = 384


_loaded: SentenceTransformer | None = None
_load_lock = threading.Lock()


def _model() -> SentenceTransformer:
    """Loaded lazily and cached in memory. The first call downloads ~90MB
    of model weights and takes a few seconds; every call after reuses it.

    Locked because worker.py runs its queues on separate threads, and two of
    them reaching for the model at once would otherwise load it twice."""
    global _loaded
    if _loaded is None:
        with _load_lock:
            if _loaded is None:
                _loaded = SentenceTransformer(MODEL_NAME)
    return _loaded


def embed(text: str) -> list[float]:
    """Embed a single string. Vectors are normalized, which pairs with the
    cosine distance operator (<=>) used in the retrieval query."""
    return _model().encode(text, normalize_embeddings=True).tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed many strings at once — much faster than looping over embed()
    because the model processes them as a batch."""
    vectors = _model().encode(texts, normalize_embeddings=True, batch_size=32)
    return [v.tolist() for v in vectors]
