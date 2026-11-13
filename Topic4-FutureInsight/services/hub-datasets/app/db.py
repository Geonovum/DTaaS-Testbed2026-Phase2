"""Persistence setup for the Hub Datasets service — the real LDT hub
dataset/resource store (see DECISIONS.md, D1). SQLite via SQLAlchemy, behind
a repository seam, like the Cookbook Registry's own store.
"""

import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("HUB_DATASETS_DB_URL", "sqlite:///./hub_datasets.db")

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def migrate() -> None:
    """Brings a database created by an older version of this service up to
    the current models. `create_all` only creates missing tables, never
    missing columns, so a persisted volume from before `resources.url`
    existed would otherwise fail on every query that selects it."""
    columns = {c["name"] for c in inspect(engine).get_columns("resources")}
    if "url" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE resources ADD COLUMN url VARCHAR"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
