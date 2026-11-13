"""SQLAlchemy ORM model for stored recipes.

Only the raw CWL text and its publishing metadata are persisted. The input
schema and the execution DAG are deliberately NOT stored — they're derived from
`cwl_text` on every request (see `app/cwl_parser.py`), so they can never drift
out of sync with the recipe that actually gets executed.
"""

import datetime

from sqlalchemy import JSON, Column, DateTime, String, Text

from .db import Base


class RecipeModel(Base):
    __tablename__ = "recipes"

    id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    description = Column(String, nullable=True)
    keywords = Column(JSON, nullable=False, default=list)
    cwl_text = Column(Text, nullable=False)

    created = Column(DateTime, default=datetime.datetime.utcnow)
    updated = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
