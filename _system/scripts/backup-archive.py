#!/usr/bin/python3
# Encoding: UTF-8
"""Bounded ZIP I/O for EchoPaper. No archive-supplied code is executed."""
import hashlib
import json
import os
import pathlib
import stat
import sys
import zipfile

MAX_TOTAL = 4 * 1024**3
MAX_FILE = 2 * 1024**3
MAX_ENTRIES = 100000

def safe_name(name, directory=False):
    if not isinstance(name, str) or not name or '\\' in name or '\x00' in name or name.startswith('/'):
        raise ValueError('unsafe archive path')
    if directory:
        name = name.rstrip('/')
    parts = name.split('/')
    if any(p in ('', '.', '..') or ':' in p or any(ord(c) < 32 for c in p) for p in parts):
        raise ValueError('unsafe archive path')
    if parts[0] not in ('papers', 'shared', 'archive', 'workspace') and name not in ('_system', '_system/runtime', '_system/runtime/ai-settings.json', '_system/runtime/model-providers.json'):
        raise ValueError('archive path outside backup scope')
    return name

def manifest_from(z):
    entries = z.infolist()
    if len(entries) > MAX_ENTRIES * 2 + 1 or len({i.filename for i in entries}) != len(entries):
        raise ValueError('too many or duplicate archive entries')
    info = z.getinfo('manifest.json')
    if info.file_size > 16 * 1024**2:
        raise ValueError('manifest too large')
    m = json.loads(z.read(info).decode('utf-8'))
    if not isinstance(m, dict) or m.get('schemaVersion') != 1 or not isinstance(m.get('files'), list) or not isinstance(m.get('directories'), list):
        raise ValueError('invalid manifest')
    if len(m['files']) > MAX_ENTRIES or len(m['directories']) > MAX_ENTRIES:
        raise ValueError('manifest too large')
    expected = {'manifest.json'}
    total = 0
    for d in m['directories']:
        name = safe_name(d, True)
        if name + '/' in expected:
            raise ValueError('duplicate directory')
        expected.add(name + '/')
    for f in m['files']:
        if not isinstance(f, dict):
            raise ValueError('invalid file record')
        name = safe_name(f.get('path'))
        size, digest = f.get('size'), f.get('sha256')
        if type(size) is not int or size < 0 or size > MAX_FILE or not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('invalid file record')
        if name in expected or name + '/' in expected:
            raise ValueError('duplicate file')
        expected.add(name)
        total += size
    if total > MAX_TOTAL or set(i.filename for i in entries) != expected:
        raise ValueError('size budget or manifest entries mismatch')
    for i in entries:
        mode = i.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or i.flag_bits & 1:
            raise ValueError('unsupported file type or encrypted entry')
        if i.file_size > MAX_FILE:
            raise ValueError('file too large')
        if i.filename != 'manifest.json':
            safe_name(i.filename, i.is_dir())
    return m

def verify(z, m, destination=None):
    if destination:
        root = pathlib.Path(destination)
        root.mkdir(parents=True, exist_ok=True)
        for d in m['directories']:
            (root / d).mkdir(parents=True, exist_ok=True)
    for f in m['files']:
        info = z.getinfo(f['path'])
        if info.file_size != f['size']:
            raise ValueError('file size mismatch')
        digest = hashlib.sha256()
        out = None
        try:
            if destination:
                target = pathlib.Path(destination) / f['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                out = target.open('xb')
            count = 0
            with z.open(info) as src:
                while True:
                    chunk = src.read(1024**2)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > f['size']:
                        raise ValueError('expanded file too large')
                    digest.update(chunk)
                    if out:
                        out.write(chunk)
            if count != f['size'] or digest.hexdigest() != f['sha256']:
                raise ValueError('file checksum mismatch')
        finally:
            if out:
                out.close()
        if destination:
            os.chmod(str(target), int(f.get('mode', 0o600)) & 0o777)

os.umask(0o077)
mode = sys.argv[1]
if mode == 'create':
    source, archive = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    m = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
        z.write(source / 'manifest.json', 'manifest.json')
        for d in m['directories']:
            z.write(source / d, d + '/')
        for f in m['files']:
            z.write(source / f['path'], f['path'])
    with zipfile.ZipFile(archive) as z:
        checked = manifest_from(z)
        verify(z, checked)
else:
    with zipfile.ZipFile(sys.argv[2]) as z:
        m = manifest_from(z)
        verify(z, m, sys.argv[3] if mode == 'extract' else None)
        print(json.dumps(m, ensure_ascii=True))
