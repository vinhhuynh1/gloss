import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Anchored to this file rather than the working directory: a bare
# load_dotenv() only finds .env when the process happens to start in
# apps/api. On a PaaS there is no .env file and this is a no-op — real
# environment variables win either way.
load_dotenv(Path(__file__).with_name(".env"))

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    # Deliberately fatal. A localhost default looks like it works and turns a
    # missing production variable into a confusing connection error instead of
    # a clear configuration one.
    raise RuntimeError(
        "DATABASE_URL is not set. Copy .env.example to .env for local "
        "development, or set it in the deployment environment. Expected "
        "format: postgresql+psycopg://user:password@host:5432/dbname"
    )

# Supabase note: use the SESSION pooler host (port 5432). The direct host
# db.<ref>.supabase.co is IPv6-only on the free tier, which most IPv4-only
# platforms cannot reach. If you switch to the TRANSACTION pooler on 6543,
# add connect_args={"prepare_threshold": None} — psycopg3 otherwise fails on
# the second request because the pooler does not keep prepared statements.
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: yields a session, closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
