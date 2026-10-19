"""The asset inventory an engine run consumes: structures, elements, programmes, settings."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd


@dataclass
class Inventory:
    structures: pd.DataFrame
    elements: pd.DataFrame
    planned: pd.DataFrame = field(default_factory=pd.DataFrame)
    routine: pd.DataFrame = field(default_factory=pd.DataFrame)
    settings: dict = field(default_factory=dict)

    @property
    def authority_type(self) -> str:
        return self.settings.get("authority_type") or "Local Authority"

    @classmethod
    def from_dir(cls, path: str | Path) -> "Inventory":
        """Load a directory of Parquet (or CSV) input tables plus settings.json."""
        path = Path(path)

        def read(name: str) -> pd.DataFrame:
            for ext, reader in ((".parquet", pd.read_parquet), (".csv", pd.read_csv)):
                p = path / f"{name}{ext}"
                if p.exists():
                    return reader(p)
            return pd.DataFrame()

        settings_path = path / "settings.json"
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        return cls(read("structures"), read("elements"), read("planned"), read("routine"), settings)

    @classmethod
    def from_savi_workbook(cls, path: str | Path) -> "Inventory":
        from .io.savi_workbook import SaviWorkbook, read_inventory
        raw = read_inventory(SaviWorkbook.open(path))
        return cls(raw.structures, raw.elements, raw.planned, raw.routine, raw.settings)

    @classmethod
    def load(cls, path: str | Path) -> "Inventory":
        path = Path(path)
        if path.suffix.lower() in {".xlsm", ".xlsx"}:
            return cls.from_savi_workbook(path)
        return cls.from_dir(path)
