#!/usr/bin/env python3
"""Extract one explicitly selected FHWA state member without trusting ZIP paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile
import zipfile


def extract(archive: Path, member: str, destination: Path):
    if archive.stat().st_size > 128_000_000:
        raise ValueError("Source archive exceeds 128 MB.")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 1000 or sum(e.file_size for e in entries) > 2_000_000_000:
            raise ValueError("Source archive inventory exceeds its bound.")
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                    or "\x00" in entry.filename or ":" in entry.filename
                    or entry.filename.casefold() in names
                    or stat.S_ISLNK(entry.external_attr >> 16)
                    or entry.flag_bits & 1
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or entry.file_size > 50_000_000
                    or entry.file_size > max(1, entry.compress_size) * 250):
                raise ValueError("Unsafe or oversized ZIP member; nothing was extracted.")
            names.add(entry.filename.casefold())
        item = source.getinfo(member)
        if item.is_dir():
            raise ValueError("Select an exact source file.")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".pending", delete=False) as out:
                temporary = Path(out.name)
                digest, size = hashlib.sha256(), 0
                with source.open(item) as incoming:
                    while True:
                        chunk = incoming.read(65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 50_000_000 or size > item.file_size:
                            raise ValueError("Source decompression exceeded its declared bound.")
                        digest.update(chunk)
                        out.write(chunk)
                if size != item.file_size:
                    raise ValueError("Source member was incomplete.")
                out.flush()
                os.fsync(out.fileno())
            sha = digest.hexdigest()
            if destination.exists():
                if destination.is_symlink() or destination.stat().st_size != size or hashlib.sha256(destination.read_bytes()).hexdigest() != sha:
                    raise ValueError("A retained source member changed; do not overwrite source evidence.")
            else:
                os.link(temporary, destination)
            return {"member": member, "sha256": sha, "bytes": size}
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--member", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(extract(args.archive, args.member, args.output)))
