"""Package marker for scripts/rig_mappings/. Re-exports the loader
public API so callers can do `from rig_mappings import load_mapping`."""
from ._loader import (  # noqa: F401
    Mapping,
    fingerprint_skeleton,
    list_supported_pairs,
    load_mapping,
    make_classifier_chain,
)
