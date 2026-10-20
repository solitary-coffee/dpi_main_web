#!/usr/bin/env python3
"""Restore a local installer backup. Stop affected services before running."""
import argparse
import json
from pathlib import Path
import shutil


def restore(root, backup):
    root, backup = root.resolve(), backup.resolve()
    if not backup.is_relative_to(root / '.dpi-mode/backups'):
        raise ValueError('Backup must be inside this installation')
    entries = json.loads((backup / 'rollback.json').read_text())
    # Validate everything before writing; never accept arbitrary traversal paths.
    for relative, existed in entries.items():
        if not (root / relative).resolve().is_relative_to(root) or Path(relative).is_absolute():
            raise ValueError('Unsafe rollback path')
        if existed and not (backup / relative).is_file():
            raise ValueError('Original file missing: ' + relative)
    for relative, existed in entries.items():
        target = root / relative
        if existed:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup / relative, target)
        elif target.exists():
            target.unlink()
    print('Restored originals. Restart affected services to load them.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--backup', required=True, type=Path)
    args = parser.parse_args()
    restore(args.root, args.backup)
