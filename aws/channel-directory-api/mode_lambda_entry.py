"""Preserve the existing Lambda handler/layers and expose a no-send IAM probe."""
import importlib
from functools import lru_cache

import mode_hooks


@lru_cache(maxsize=1)
def original():
    name = mode_hooks.setting("DPI_MODE_ORIGINAL_HANDLER")
    module, function = name.rsplit(".", 1)
    if module == __name__:
        raise ValueError("recursive original handler")
    return getattr(importlib.import_module(module), function)


def handler(event, context):
    if (isinstance(event, dict) and event.get("_dpi_mode_probe") is True
            and not event.get("requestContext") and not event.get("httpMethod")):
        # Direct InvokeFunction is IAM-authorized. Public HTTP events never
        # enter this branch. Probe loads code and reads mode; it sends nothing.
        importlib.import_module(mode_hooks.setting("DPI_MODE_PROBE_MODULE"))
        return mode_hooks.probe()
    return original()(event, context)
