"""Repository layer — the sole place that talks to the datastore, same
pattern (and same reasoning) as ../../records-wrapper/app/repository.py.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from . import models


class DatasetRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_datasets(self) -> list[models.DatasetModel]:
        return self.db.query(models.DatasetModel).order_by(models.DatasetModel.created.asc()).all()

    def get_dataset(self, dataset_id: str) -> models.DatasetModel | None:
        return self.db.query(models.DatasetModel).filter(models.DatasetModel.id == dataset_id).first()

    def create_dataset_if_missing(self, dataset: models.DatasetModel) -> models.DatasetModel:
        existing = self.get_dataset(dataset.id)
        if existing:
            return existing
        self.db.add(dataset)
        self.db.commit()
        return self.get_dataset(dataset.id)

    def list_resources(self, dataset_id: str) -> list[models.ResourceModel]:
        return (
            self.db.query(models.ResourceModel)
            .filter(models.ResourceModel.dataset_id == dataset_id)
            .order_by(models.ResourceModel.created.asc())
            .all()
        )

    def get_resource(self, dataset_id: str, resource_id: str) -> models.ResourceModel | None:
        return (
            self.db.query(models.ResourceModel)
            .filter(models.ResourceModel.dataset_id == dataset_id, models.ResourceModel.id == resource_id)
            .first()
        )

    def create_resource_if_missing(self, resource: models.ResourceModel) -> models.ResourceModel:
        existing = self.get_resource(resource.dataset_id, resource.id)
        if existing:
            return existing
        self.db.add(resource)
        self.db.commit()
        return self.get_resource(resource.dataset_id, resource.id)

    def sync_seeded_resource_metadata(
        self, dataset_id: str, resource_id: str, *, name: str, format: str, url: str | None = None
    ) -> None:
        """Keeps a built-in seed resource's definitional metadata (name,
        format, url) in sync with the code on every startup — unlike
        create_resource_if_missing, this DOES update an already-existing row.
        Only ever called for the small, fixed set of resources _seed()
        creates; never touches a user-saved resource (e.g. a live recipe's
        "Save to Hub" result), which has no counterpart call to this."""
        resource = self.get_resource(dataset_id, resource_id)
        if not resource:
            return
        resource.name = name
        resource.format = format
        resource.url = url
        self.db.commit()

    def create_resource(self, resource: models.ResourceModel) -> models.ResourceModel:
        self.db.add(resource)
        self.db.commit()
        return self.get_resource(resource.dataset_id, resource.id)

    def delete_resource(self, resource: models.ResourceModel) -> None:
        self.db.delete(resource)
        self.db.commit()

    def delete_all_resources(self, dataset_id: str, exclude_ids: set[str] | None = None) -> int:
        """Deletes every resource in a dataset except `exclude_ids` (a live,
        seeded resource like the PDOK boundary — see main.py's
        PROTECTED_RESOURCE_IDS — must survive a "Delete All" demo reset, since
        it's not user-saved data but a picker's only real option). Returns the
        number of rows actually deleted."""
        query = self.db.query(models.ResourceModel).filter(models.ResourceModel.dataset_id == dataset_id)
        if exclude_ids:
            query = query.filter(models.ResourceModel.id.notin_(exclude_ids))
        count = query.count()
        query.delete(synchronize_session=False)
        self.db.commit()
        return count
