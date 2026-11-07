#!/usr/bin/env python3
"""Bounded operator-only, reference-complete OSM extraction for the traffic worker.

Requires isolated PyOsmium 4.3.0. Never downloads or changes the original PBF.
The bbox is the full analytical study + explicit buffer envelope, not a clip of
rendered roads. Complete intersecting highway ways and restriction members remain.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import resource
import signal
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--bounds', required=True, help='west,south,east,north including buffer')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_AS, (3 * 1024**3, 3 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024**3, 2 * 1024**3))
    signal.alarm(240)
    import osmium
    if importlib.metadata.version('osmium') != '4.3.0':
        raise ValueError('Use the pinned PyOsmium 4.3.0 operator environment.')
    bounds = tuple(float(x) for x in args.bounds.split(','))
    if len(bounds) != 4 or not all(math.isfinite(x) for x in bounds):
        raise ValueError('Invalid bounds.')
    w, s, e, n = bounds
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError('Invalid bounds.')
    km2 = (e-w) * 111.32 * math.cos(math.radians((n+s)/2)) * (n-s) * 110.574
    if km2 > 300:
        raise ValueError('Traffic source envelope exceeds 300 square kilometres; nothing was truncated.')
    source, output = Path(args.source).resolve(), Path(args.output).resolve()
    if output.exists() or output.with_suffix('.receipt.json').exists():
        raise ValueError('Refusing to overwrite a captured extraction.')
    size = source.stat().st_size
    if not source.is_file() or size > 512 * 1024**2:
        raise ValueError('Source PBF exceeds 512 MiB.')
    h = hashlib.sha256()
    with source.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            h.update(block)
    if h.hexdigest() != args.sha256:
        raise ValueError('Source SHA-256 does not match the retained source receipt.')
    started = time.monotonic()
    selected, nodes, restrictions = set(), set(), set()

    def intersects(a, b):
        # Liang-Barsky against the exact supplied envelope, including crossing
        # ways that have no vertex inside it. No geometry is simplified/clipped.
        lo, hi = 0.0, 1.0
        dx, dy = b[0]-a[0], b[1]-a[1]
        for p, q in ((-dx, a[0]-w), (dx, e-a[0]), (-dy, a[1]-s), (dy, n-a[1])):
            if p == 0:
                if q < 0: return False
            else:
                t = q / p
                if p < 0: lo = max(lo, t)
                else: hi = min(hi, t)
                if lo > hi: return False
        return True

    class Selection(osmium.SimpleHandler):
        def way(self, way):
            if way.tags.get('highway') not in {
                'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary',
                'primary_link', 'secondary', 'secondary_link', 'tertiary',
                'tertiary_link', 'unclassified', 'residential', 'living_street',
                'service', 'road',
            }:
                return
            points = [(r.lon, r.lat) for r in way.nodes]
            if any(intersects(a, b) for a, b in zip(points, points[1:])):
                selected.add(way.id)
                if len(selected) > 20000:
                    raise ValueError('Source exceeds 20,000 highway ways; nothing was truncated.')
        def relation(self, relation):
            if relation.tags.get('type') == 'restriction' and any(m.type == 'w' and m.ref in selected for m in relation.members):
                restrictions.add(relation.id)
                for member in relation.members:
                    if member.type == 'w': selected.add(member.ref)
                    elif member.type == 'n': nodes.add(member.ref)
                    else: raise ValueError('Nested turn-restriction relation is unsupported; no restriction was dropped.')

    # Explicit two-thread readers plus bounded address space prevent the default
    # machine-sized decompression pool from overwhelming a small operator host.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='traffic-extract-', dir=output.parent) as temporary:
        pool = osmium.io.ThreadPool(2)
        index = osmium.index.create_map('flex_mem')
        locations = osmium.NodeLocationsForWays(index)
        with osmium.io.Reader(str(source), thread_pool=pool) as reader:
            osmium.apply(reader, locations, Selection())
        print(json.dumps({'stage':'selected','ways':len(selected),'restrictions':len(restrictions)}),flush=True)
        del locations, index
        # Explicit bounded passes avoid a hidden default thread pool in the
        # convenience back-reference writer. Preserve all node/way/relation tags.
        class References(osmium.SimpleHandler):
            def way(self, way):
                if way.id in selected:
                    nodes.update(r.ref for r in way.nodes)
                    if len(nodes) > 500000: raise ValueError('Complete source exceeds 500,000 referenced nodes.')
        with osmium.io.Reader(str(source), thread_pool=pool) as reader:
            osmium.apply(reader, References())
        written = {'nodes':0,'ways':0,'restrictions':0}
        with osmium.SimpleWriter(str(Path(temporary)/'source.osm.xml'), thread_pool=pool) as writer:
            class Write(osmium.SimpleHandler):
                def node(self, node):
                    if node.id in nodes:
                        writer.add_node(node)
                        written['nodes'] += 1
                def way(self, way):
                    if way.id in selected:
                        writer.add_way(way)
                        written['ways'] += 1
                def relation(self, relation):
                    if relation.id in restrictions:
                        writer.add_relation(relation)
                        written['restrictions'] += 1
            with osmium.io.Reader(str(source), thread_pool=pool) as reader:
                osmium.apply(reader, Write())
        if written != {'nodes':len(nodes),'ways':len(selected),'restrictions':len(restrictions)}:
            raise ValueError('The retained source is not reference complete; no partial graph accepted.')
        raw = (Path(temporary)/'source.osm.xml').read_bytes()
        if len(raw) > 100 * 1024**2:
            raise ValueError('Reference-complete extract exceeds 100 MiB.')
        with output.open('xb') as f:
            f.write(raw)
    receipt = {
        'version': 1, 'extractor': 'PyOsmium 4.3.0', 'sourceSha256': h.hexdigest(),
        'sourceBytes': size, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
        'bounds': bounds, 'intersectingHighwayWays': len(selected),
        'retainedRestrictionRelations': len(restrictions),
        'wallSeconds': round(time.monotonic()-started, 3),
        'peakRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        'notes': ['Complete source ways retained, including reference-complete restriction members. The extraction does not infer junctions at geometric crossings.']}
    output.with_suffix('.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
