"""Wire-independent internal representation of a catalog Record.

This is the wrapper's internal shape, not the OGC API Records wire format —
the wire format (a "Record" / GeoJSON-like Feature) is built from this in
`app/main.py::record_to_feature`. Keeping these separate means the backing
store (real CKAN, see `app/repository.py` and DECISIONS.md, D14) can be
swapped without changing the API contract, and vice versa.
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Optional


@dataclasses.dataclass
class RecordModel:
    id: str
    collection_id: str = "recipes"
    type: str = "recipe"
    title: str = ""
    description: Optional[str] = None
    keywords: list[str] = dataclasses.field(default_factory=list)

    # Pointer into the Cookbook API Registry — the raw recipe payload (a CWL
    # document) lives there, not here. The catalog only ever stores discovery
    # metadata plus a link, per the architecture's "metadata contains URL
    # link to Cookbook file" design.
    cookbook_url: Optional[str] = None
    cwl_media_type: Optional[str] = "application/cwl+yaml"

    created: Optional[datetime.datetime] = None
    updated: Optional[datetime.datetime] = None
