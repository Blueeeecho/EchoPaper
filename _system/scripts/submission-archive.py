"""Portable ZIP creation and bounded extraction for submission verification."""
import os
from pathlib import Path
import stat
import sys
import zipfile

MAX_BYTES = 4 * 1024 ** 3
MAX_FILES = 100000

mode, source, destination = sys.argv[1:4]
source, destination = Path(source), Path(destination)
if mode == 'create':
    with zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for root, directories, files in os.walk(source, followlinks=False):
            for name in directories + files:
                item = Path(root) / name
                if item.is_symlink():
                    raise ValueError('Submission contains a symbolic link')
                archive.write(item, item.relative_to(source).as_posix())
elif mode == 'extract':
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        names = set()
        if len(entries) > MAX_FILES or sum(item.file_size for item in entries) > MAX_BYTES:
            raise ValueError('Archive exceeds size budget')
        for item in entries:
            parts = item.filename.rstrip('/').split('/')
            mode = item.external_attr >> 16
            if (not parts or any(part in ('', '.', '..') or ':' in part for part in parts)
                    or '\\' in item.filename or '\x00' in item.filename
                    or item.filename in names or item.flag_bits & 1
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('Unsafe archive entry')
            names.add(item.filename)
        for item in entries:
            target = destination.joinpath(*item.filename.rstrip('/').split('/'))
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as reader, target.open('xb') as writer:
                    while chunk := reader.read(1024 * 1024):
                        writer.write(chunk)
else:
    raise ValueError('Unknown archive operation')
