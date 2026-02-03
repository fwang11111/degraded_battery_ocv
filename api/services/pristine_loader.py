from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from api.models.schemas import PristineProfile


@dataclass(frozen=True)
class PristineCatalog:
    profiles: dict[str, PristineProfile]


def load_pristine_profiles(pristine_dir: Path) -> PristineCatalog:
    profiles: dict[str, PristineProfile] = {}

    if not pristine_dir.exists():
        return PristineCatalog(profiles={})

    for path in sorted(pristine_dir.glob('*.json')):
        with path.open('r', encoding='utf-8') as f:
            raw = json.load(f)
        profile = PristineProfile.model_validate(raw)
        profiles[profile.id] = profile

    return PristineCatalog(profiles=profiles)


def resolve_profile_csv_path(api_root: Path, csv_path: str) -> Path:
    p = Path(csv_path)
    if p.is_absolute():
        return p
    return (api_root / p).resolve()
