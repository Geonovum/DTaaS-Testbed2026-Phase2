"""SQLAlchemy ORM models for the Hub Datasets store.

Two tables, mirroring the Dataset/Resource shape the UI's fixture catalogue
(UI/data/datasets.json) already uses, so js/data.js can merge real rows from
here into that same shape with no translation layer: a Dataset owns many
Resources. A Resource's data lives in one of three places: stored `content`
(e.g. a saved recipe run result), an external `url` (a link-only resource,
e.g. a point cloud far too large to store here), or a live upstream fetched
on every read (the PDOK boundary — see main.py's LIVE_PDOK_RESOURCE_ID).
"""

import datetime
import uuid

from sqlalchemy import JSON, Column, DateTime, ForeignKey, String
from sqlalchemy.orm import relationship

from .db import Base


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class DatasetModel(Base):
    __tablename__ = "datasets"

    id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    description = Column(String, nullable=True)
    owner_hub_id = Column(String, nullable=True)
    owner_hub_name = Column(String, nullable=True)
    license = Column(String, nullable=False, default="CC0 1.0")
    findability = Column(String, nullable=False, default="PUBLIC")
    tags = Column(JSON, nullable=False, default=list)
    created = Column(DateTime, default=datetime.datetime.utcnow)

    resources = relationship("ResourceModel", back_populates="dataset", cascade="all, delete-orphan")


class ResourceModel(Base):
    __tablename__ = "resources"

    id = Column(String, primary_key=True, default=lambda: _new_id("res"))
    dataset_id = Column(String, ForeignKey("datasets.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    format = Column(String, nullable=False, default="geojson")
    # Stored content for an ordinary resource (e.g. a saved recipe run
    # result). Null for a link-only resource (see `url`) and for the live
    # PDOK resource, whose content is fetched on every read instead — see
    # main.py's LIVE_PDOK_RESOURCE_ID and get_resource_data.
    content = Column(JSON, nullable=True)
    # Where a link-only resource's data actually lives (e.g. a public AHN
    # LAZ tile). Null for every resource whose data this service serves
    # itself. Added after the first deployments — see db.migrate().
    url = Column(String, nullable=True)
    created = Column(DateTime, default=datetime.datetime.utcnow)

    dataset = relationship("DatasetModel", back_populates="resources")
