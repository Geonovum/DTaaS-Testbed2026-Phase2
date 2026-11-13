"""Repository layer — the sole place that talks to the datastore.

Same swap-seam discipline as the Records Wrapper's repository.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from . import models


class RecipeRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(self) -> list[models.RecipeModel]:
        return self.db.query(models.RecipeModel).order_by(models.RecipeModel.created.desc()).all()

    def get(self, recipe_id: str) -> models.RecipeModel | None:
        return self.db.query(models.RecipeModel).filter(models.RecipeModel.id == recipe_id).first()

    def upsert(self, recipe: models.RecipeModel) -> models.RecipeModel:
        self.db.merge(recipe)
        self.db.commit()
        return self.get(recipe.id)

    def delete(self, recipe_id: str) -> bool:
        obj = self.get(recipe_id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True
