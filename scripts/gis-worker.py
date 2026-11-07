#!/usr/bin/env python3
"""Offline, bounded GIS conversion. Run only inside the confined GIS container.

No uploaded filenames, CRS strings, SQL, URLs or CLI fragments are executed.
The trusted host writes /input/request.json and an optional /input/source file.
"""
import collections
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import struct
import sys
import zipfile

from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()
osr.SetPROJEnableNetwork(False)
for key, value in {
    "PROJ_NETWORK": "OFF", "GDAL_PAM_ENABLED": "NO",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": "",
    "DXF_CLOSED_LINE_AS_POLYGON": "TRUE", "DXF_INLINE_BLOCKS": "FALSE",
    "DXF_FEATURE_LIMIT_PER_BLOCK": "5000", "OGR_ORGANIZE_POLYGONS": "DEFAULT",
}.items():
    gdal.SetConfigOption(key, value)

INPUT_LIMIT = 20 * 1024**2
EXPANDED_LIMIT = 100 * 1024**2
FEATURE_LIMIT = 5000
VERTEX_LIMIT = 50000
INSPECTION_LIMIT = 100000
UNIT_METERS = {"meters": 1, "feet": 0.3048, "us-survey-feet": 1200 / 3937,
               "millimeters": 0.001, "centimeters": 0.01, "inches": 0.0254}


class Rejected(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise Rejected(code, message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_bounded(path, limit):
    if path.stat().st_size > limit:
        fail("GIS_TOO_LARGE", "The GIS input exceeds its configured byte limit.")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        fail("GIS_TOO_LARGE", "The GIS input exceeds its configured byte limit.")
    return data


def safe_name(name):
    return (isinstance(name, str) and 0 < len(name) <= 240 and "\\" not in name
            and "\x00" not in name and ":" not in name and not name.startswith("/")
            and all(part not in ("", ".", "..") for part in name.split("/")))


def verify_shapefile(shp):
    """Check record/component accounting before GDAL can omit inconsistent rows."""
    shx, dbf = shp.with_suffix(".shx"), shp.with_suffix(".dbf")
    if not shx.exists() or not dbf.exists():
        fail("GIS_COMPONENT_MISSING", "Every Shapefile layer needs matching .shp, .shx and .dbf components.")
    shape, index, table = [read_bounded(p, EXPANDED_LIMIT) for p in (shp, shx, dbf)]
    if len(shape) < 100 or len(index) < 100 or (len(index) - 100) % 8 or len(table) < 33:
        fail("GIS_INVALID_SHAPEFILE", "A Shapefile component is truncated or malformed.")
    for value in (shape, index):
        if struct.unpack_from(">i", value)[0] != 9994 or struct.unpack_from(">i", value, 24)[0] * 2 != len(value):
            fail("GIS_INVALID_SHAPEFILE", "A Shapefile component has an invalid file header or length.")
    offsets, at = [], 100
    while at < len(shape):
        if at + 8 > len(shape):
            fail("GIS_INVALID_SHAPEFILE", "A Shapefile record header is truncated.")
        number, words = struct.unpack_from(">ii", shape, at)
        if words < 2 or number != len(offsets) + 1 or at + 8 + words * 2 > len(shape):
            fail("GIS_INVALID_SHAPEFILE", "A Shapefile geometry record is invalid.")
        offsets.append((at // 2, words))
        at += 8 + words * 2
        if len(offsets) > INSPECTION_LIMIT:
            fail("GIS_TOO_LARGE", "The layer exceeds the 100,000-entity inspection limit.")
    indices = [struct.unpack_from(">ii", index, n) for n in range(100, len(index), 8)]
    count, header, record = struct.unpack_from("<IHH", table, 4)
    if indices != offsets or count != len(offsets) or header < 33 or record < 1 or header + count * record > len(table):
        fail("GIS_COMPONENT_MISMATCH", "Shapefile geometry, index and attribute records do not match.")
    if any(table[header + n * record] == 42 for n in range(count)):
        fail("GIS_DELETED_RECORDS", "The DBF contains deleted records. Export a clean dataset so no features are silently omitted.")


def unzip_shapes(path):
    root = pathlib.Path("/tmp/shapes")
    root.mkdir(mode=0o700)
    names, members, total = set(), [], 0
    try:
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 100:
                fail("GIS_ARCHIVE_LIMIT", "The archive exceeds 100 members.")
            for item in archive.infolist():
                name = item.filename.rstrip("/") if item.is_dir() else item.filename
                if not safe_name(name) or name.casefold() in names:
                    fail("GIS_UNSAFE_ARCHIVE", "Archive names must be unique relative paths without traversal.")
                names.add(name.casefold())
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or item.flag_bits & 1:
                    fail("GIS_UNSAFE_ARCHIVE", "Links, special files and encrypted archive entries are not supported.")
                if item.is_dir():
                    continue
                suffix = pathlib.PurePosixPath(name).suffix.lower()
                metadata = name.casefold() == "manifest.json" or name.casefold().endswith(".exact.geojson")
                if suffix not in (".shp", ".shx", ".dbf", ".prj", ".cpg") and not metadata:
                    fail("GIS_ARCHIVE_MEMBER", "A Shapefile archive may contain only .shp, .shx, .dbf, .prj and .cpg files.")
                total += item.file_size
                if total > EXPANDED_LIMIT:
                    fail("GIS_ARCHIVE_LIMIT", "The archive exceeds 100 MiB expanded.")
                # Lowercase paths give case-insensitive component matching without collisions.
                target = root.joinpath(name.casefold())
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                count, hasher = 0, hashlib.sha256()
                with archive.open(item) as source, target.open("xb") as output:
                    while True:
                        chunk = source.read(min(65536, EXPANDED_LIMIT - count + 1))
                        if not chunk:
                            break
                        count += len(chunk)
                        if count > item.file_size or count > EXPANDED_LIMIT:
                            fail("GIS_ARCHIVE_LIMIT", "Expanded archive bytes exceed their declaration or configured limit.")
                        hasher.update(chunk)
                        output.write(chunk)
                if count != item.file_size:
                    fail("GIS_INVALID_ARCHIVE", "An archive member is truncated.")
                members.append({"name": name, "sha256": hasher.hexdigest(), "bytes": count})
    except (zipfile.BadZipFile, RuntimeError, EOFError):
        fail("GIS_INVALID_ARCHIVE", "The Shapefile archive is corrupt or unsupported.")
    shapes = sorted(root.rglob("*.shp"))
    if not shapes:
        fail("GIS_COMPONENT_MISSING", "The archive contains no .shp layer.")
    expected = {str(p.with_suffix("")) for p in shapes}
    for p in root.rglob("*"):
        if p.is_file() and p.suffix not in (".json", ".geojson") and str(p.with_suffix("")) not in expected:
            fail("GIS_COMPONENT_MISMATCH", "The archive contains an orphan Shapefile sidecar.")
    for shp in shapes:
        verify_shapefile(shp)
    return [(str(p.relative_to(root)), p) for p in shapes], members


def spatial_reference(value):
    if value is None:
        return None
    s = value.Clone()
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return s


def crs_info(s):
    if s is None:
        return None
    authority = s.GetAuthorityName(None)
    code = s.GetAuthorityCode(None)
    return {"wkt": s.ExportToWkt(), "authority": f"{authority}:{code}" if authority and code else None,
            "unit": s.GetLinearUnitsName() if s.IsProjected() else s.GetAngularUnitsName()}


def vertices(geometry):
    if not geometry:
        return 0
    return geometry.GetPointCount() + sum(vertices(geometry.GetGeometryRef(i)) for i in range(geometry.GetGeometryCount()))


def dxf_entities(path):
    """Account for raw ENTITIES too: GDAL may not emit unsupported CAD entities."""
    raw = read_bounded(path, INPUT_LIMIT)
    pairs = []
    signature = b"AutoCAD Binary DXF\r\n\x1a\x00"
    if raw.startswith(signature):
        at = len(signature)
        modern = raw[at:at+2] == b"\x00\x00"
        def take(n):
            nonlocal at
            if at+n > len(raw): fail("GIS_INVALID_DXF", "The binary DXF is truncated.")
            value=raw[at:at+n];at+=n;return value
        def string():
            nonlocal at
            end=raw.find(b"\x00",at)
            if end<0 or end-at>65536:fail("GIS_INVALID_DXF","The binary DXF contains an invalid string.")
            value=raw[at:end];at=end+1;return value.decode("utf8",errors="replace")
        while at<len(raw):
            code=struct.unpack("<H",take(2))[0] if modern else take(1)[0]
            if not modern and code==255:code=struct.unpack("<H",take(2))[0]
            if (0<=code<=9 or code in (100,102,105,999) or 300<=code<=309 or 320<=code<=369 or 390<=code<=399 or 410<=code<=419 or 430<=code<=439 or 470<=code<=481 or 1000<=code<=1009 and code!=1004):value=string()
            elif 10<=code<=59 or 110<=code<=149 or 210<=code<=239 or 460<=code<=469 or 1010<=code<=1059:value=struct.unpack("<d",take(8))[0]
            elif 60<=code<=79 or 170<=code<=179 or 270<=code<=289 or 370<=code<=389 or 400<=code<=409 or 1060<=code<=1070:value=struct.unpack("<h",take(2))[0]
            elif 90<=code<=99 or 420<=code<=429 or 440<=code<=459 or code==1071:value=struct.unpack("<i",take(4))[0]
            elif 160<=code<=169:value=struct.unpack("<q",take(8))[0]
            elif 290<=code<=299:value=take(1)[0]
            elif 310<=code<=319 or code==1004:value=take(take(1)[0])
            else:fail("GIS_BINARY_DXF_GROUP","The binary DXF uses an unsupported group code; no entity accounting was guessed.")
            pairs.append((code,value))
    else:
        try:text=raw.decode("utf8")
        except UnicodeError:text=raw.decode("cp1252")
        lines=text.splitlines()
        if len(lines)%2:fail("GIS_INVALID_DXF","DXF group codes and values must be paired.")
        try:pairs=[(int(lines[n].strip()),lines[n+1].strip()) for n in range(0,len(lines),2)]
        except ValueError:fail("GIS_INVALID_DXF","The DXF contains a malformed group code.")
    entities,section,current,handles=[],None,None,set()
    def finish():
        nonlocal current
        if not current:return
        if current["type"] not in ("VERTEX","SEQEND","ATTRIB"):
            handle=current.get("handle")
            if not handle or len(handle)>240 or len(current["layer"])>240 or len(current["type"])>240 or handle in handles:fail("GIS_DXF_IDENTITY","Each top-level CAD entity needs a unique bounded handle and layer name for complete source accounting.")
            handles.add(handle);entities.append(current)
            if len(entities)>INSPECTION_LIMIT:fail("GIS_TOO_LARGE","DXF exceeds the 100,000-entity inspection limit.")
        current=None
    for n,(code,value) in enumerate(pairs):
        if code==0 and value=="SECTION":
            finish();section=pairs[n+1][1] if n+1<len(pairs) and pairs[n+1][0]==2 else None
        elif code==0 and value=="ENDSEC":finish();section=None
        elif section=="ENTITIES":
            if code==0:
                finish();current={"type":str(value),"layer":"0","paper":False}
            elif current is not None:
                if code==5:current["handle"]=str(value)
                elif code==8:current["layer"]=str(value)
                elif code==67:current["paper"]=str(value)=="1"
    finish()
    return entities


def records(path, fmt, recipe=None):
    """Return materialized bounded records; input itself is capped before parsing."""
    recipe = recipe or {}
    if fmt == "geojson":
        try:
            payload = json.loads(read_bounded(path, INPUT_LIMIT))
        except (ValueError, UnicodeError):
            fail("GIS_INVALID_GEOJSON", "The uploaded GeoJSON is invalid JSON.")
        if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            fail("GIS_INVALID_GEOJSON", "Upload a GeoJSON FeatureCollection.")
        if len(payload["features"]) > INSPECTION_LIMIT:
            fail("GIS_TOO_LARGE", "The layer exceeds the entity inspection limit.")
        s = osr.SpatialReference()
        s.ImportFromEPSG(4326)
        legacy = payload.get("crs")
        if legacy is not None:
            name = legacy.get("properties", {}).get("name") if isinstance(legacy, dict) else None
            if name not in ("EPSG:4326", "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC:1.3:CRS84", "OGC:CRS84"):
                s = None  # A caller must explicitly identify a projected source CRS.
        rows = []
        for n, feature in enumerate(payload["features"]):
            if not isinstance(feature, dict) or feature.get("type") != "Feature":
                fail("GIS_INVALID_GEOJSON", "Every GeoJSON member must be a Feature.")
            props = feature.get("properties") or {}
            if not isinstance(props, dict) or len(props) > 256:
                fail("GIS_ATTRIBUTE_LIMIT", "Each feature must have a property object with at most 256 fields.")
            geometry = ogr.CreateGeometryFromJson(json.dumps(feature.get("geometry"))) if feature.get("geometry") else None
            rows.append({"id": str(feature.get("id", n)), "geometry": geometry, "properties": props, "entity": geometry.GetGeometryName() if geometry else "NULL", "paper": False})
        return [{"id": "geojson", "name": "GeoJSON", "srs": spatial_reference(s), "rows": rows}], []
    if fmt == "shapefile":
        files, members = unzip_shapes(path)
    elif fmt == "dxf":
        files, members = [("entities", path)], []
        raw_entities = dxf_entities(path)
        if recipe.get("dxf"):
            dxf = recipe["dxf"]
            meters = UNIT_METERS[dxf["units"]]
            if dxf.get("localTransform"):
                _,fit=local_transform(dxf["localTransform"])
                meters=fit["scaleMetersPerSourceUnit"]
            gdal.SetConfigOption("OGR_ARC_MAX_GAP", str(dxf["curveToleranceMeters"] / meters))
            gdal.SetConfigOption("OGR_ARC_STEPSIZE", "1")
    else:
        fail("GIS_FORMAT", "Unsupported GIS format.")
    datasets, output, seen = [], [], 0
    for layer_id, filename in files:
        options = [f"ENCODING={recipe['encoding']}"] if recipe.get("encoding") and fmt == "shapefile" else []
        ds = gdal.OpenEx(str(filename), gdal.OF_VECTOR | gdal.OF_READONLY, allowed_drivers=["ESRI Shapefile" if fmt == "shapefile" else "DXF"], open_options=options)
        if ds is None:
            fail("GIS_OPEN_FAILED", "The selected file could not be read with its declared format.")
        datasets.append(ds)
        layer = ds.GetLayerByName("entities") if fmt == "dxf" else ds.GetLayer(0)
        if layer.GetLayerDefn().GetFieldCount() > 256:
            fail("GIS_ATTRIBUTE_LIMIT", "A layer exceeds the 256-field limit.")
        groups = {}
        for feature in layer:
            seen += 1
            if seen > INSPECTION_LIMIT:
                fail("GIS_TOO_LARGE", "The dataset exceeds the 100,000-entity inspection limit.")
            props = {feature.GetFieldDefnRef(i).GetName(): feature.GetField(i) for i in range(feature.GetFieldCount())}
            group = str(props.get("Layer", "0")) if fmt == "dxf" else layer_id
            if len(group) > 240:
                fail("GIS_LAYER_NAME", "A layer name exceeds 240 characters.")
            geometry = feature.GetGeometryRef()
            geometry = geometry.Clone() if geometry is not None else None
            entity = str(props.get("SubClasses") or (geometry.GetGeometryName() if geometry else "NULL"))
            rows = groups.setdefault(group, [])
            rows.append({"id": str(props.get("EntityHandle") or feature.GetFID()), "geometry": geometry, "properties": props, "entity": entity, "paper": props.get("PaperSpace") == 1})
        if fmt == "dxf":
            emitted={row["id"]:row for rows in groups.values() for row in rows}
            if len(emitted)!=sum(len(rows) for rows in groups.values()):fail("GIS_DXF_IDENTITY","The CAD parser emitted duplicate entity handles; no features were accepted.")
            groups={}
            for entity in raw_entities:
                row=emitted.pop(entity["handle"],None)
                if row is None:row={"id":entity["handle"],"geometry":None,"properties":{"Layer":entity["layer"],"EntityHandle":entity["handle"]},"paper":entity["paper"]}
                row["entity"]=entity["type"]
                if entity["type"] not in ("LWPOLYLINE","POLYLINE","HATCH"):row["footprintUnsupported"]=True
                groups.setdefault(entity["layer"],[]).append(row)
            if emitted:fail("GIS_DXF_IDENTITY","Parsed CAD features could not be matched to original entity handles.")
        for group, rows in groups.items():
            output.append({"id": group, "name": group, "srs": spatial_reference(layer.GetSpatialRef()), "rows": rows})
    return output, members


def supported(row):
    geometry = row["geometry"]
    return geometry is not None and ogr.GT_Flatten(geometry.GetGeometryType()) in (ogr.wkbPolygon, ogr.wkbMultiPolygon) and not row["paper"] and not row.get("footprintUnsupported",False)


def describe_layer(layer):
    rows, fields, geometry_types, entity_types = layer["rows"], {}, collections.Counter(), collections.Counter()
    envelope = None
    has_z = False
    for row in rows:
        g = row["geometry"]
        geometry_types[g.GetGeometryName() if g else "NULL"] += 1
        entity_types[row["entity"]] += 1
        if g is not None and not g.IsEmpty():
            a, b, c, d = g.GetEnvelope()
            envelope = [a, c, b, d] if envelope is None else [min(envelope[0], a), min(envelope[1], c), max(envelope[2], b), max(envelope[3], d)]
            has_z = has_z or bool(g.Is3D())
        for key, value in row["properties"].items():
            if len(key) > 240:
                fail("GIS_ATTRIBUTE_LIMIT", "A source field name exceeds 240 characters.")
            item = fields.setdefault(key, {"name": key, "type": type(value).__name__, "nullable": False, "samples": []})
            item["nullable"] = item["nullable"] or value is None
            if len(item["samples"]) < 3:
                sample = value if isinstance(value, (type(None), bool, int, float)) else str(value)[:200]
                if sample not in item["samples"]:
                    item["samples"].append(sample)
    return {"id": layer["id"], "name": layer["name"], "featureCount": len(rows), "geometryTypes": dict(geometry_types), "entityTypes": dict(entity_types), "fields": list(fields.values()), "bounds": envelope, "crs": crs_info(layer["srs"]), "supportedFootprints": sum(supported(r) for r in rows), "unsupportedEntities": sum(not supported(r) for r in rows), "hasZ": has_z}


def transform_pair(source, target):
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    options = osr.CoordinateTransformationOptions()
    options.SetBallparkAllowed(False)
    options.SetOnlyBest(True)
    return osr.CreateCoordinateTransformation(source, target, options)


def local_transform(config):
    controls, checks = config["controls"], config.get("checkpoints", [])
    lon = sum(p["target"][0] for p in controls) / len(controls)
    lat = sum(p["target"][1] for p in controls) / len(controls)
    geo = osr.SpatialReference()
    geo.ImportFromEPSG(4326)
    plane = osr.SpatialReference()
    plane.ImportFromProj4(f"+proj=aeqd +lat_0={lat:.15g} +lon_0={lon:.15g} +datum=WGS84 +units=m +no_defs")
    forward, inverse = transform_pair(geo, plane), transform_pair(plane, geo)
    targets = [forward.TransformPoint(*p["target"])[:2] for p in controls]
    sx = sum(p["source"][0] for p in controls) / len(controls)
    sy = sum(p["source"][1] for p in controls) / len(controls)
    tx = sum(p[0] for p in targets) / len(targets)
    ty = sum(p[1] for p in targets) / len(targets)
    den = sum((p["source"][0] - sx)**2 + (p["source"][1] - sy)**2 for p in controls)
    if den < 1e-12:
        fail("GIS_CONTROL_POINTS", "Control points must have distinct source coordinates.")
    a = sum((p["source"][0]-sx)*(t[0]-tx)+(p["source"][1]-sy)*(t[1]-ty) for p, t in zip(controls, targets)) / den
    b = sum((p["source"][0]-sx)*(t[1]-ty)-(p["source"][1]-sy)*(t[0]-tx) for p, t in zip(controls, targets)) / den
    if not math.isfinite(a*a+b*b) or a*a+b*b < 1e-20:
        fail("GIS_CONTROL_POINTS", "Control points must locate a nondegenerate target span.")
    def projected(p):
        x, y = p[0]-sx, p[1]-sy
        return (tx+a*x-b*y, ty+b*x+a*y)
    residuals = [math.dist(projected(p["source"]), t) for p,t in zip(controls,targets)]
    check_residuals = [math.dist(projected(p["source"]), forward.TransformPoint(*p["target"])[:2]) for p in checks]
    if max(residuals + check_residuals, default=0) > config["maximumResidualMeters"]:
        fail("GIS_CONTROL_RESIDUAL", "Control or independent checkpoint residual exceeds the reviewed tolerance.")
    def convert(x, y):
        return inverse.TransformPoint(*projected((x,y)))[:2]
    details = {"method": "least-squares-2d-similarity-in-local-AEQD", "origin": [lon,lat], "sourceCenter": [sx,sy], "targetCenterMeters": [tx,ty], "a": a, "b": b, "scaleMetersPerSourceUnit": math.hypot(a,b), "controlResidualsMeters": residuals, "checkpointResidualsMeters": check_residuals}
    return convert, details


def normalize(layers, request, input_info, converter):
    recipe = request["recipe"]
    layer = next((v for v in layers if v["id"] == recipe["layerId"]), None)
    if layer is None:
        fail("GIS_LAYER_NOT_FOUND", "The selected source layer is absent.")
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    fmt, local = request["format"], recipe.get("dxf", {}).get("localTransform")
    source, transform, local_details = None, None, None
    if fmt == "dxf" and not recipe.get("dxf"):
        fail("GIS_DXF_UNITS", "DXF import requires explicit drawing units and curve tolerance.")
    if local:
        if recipe.get("sourceCrs"):
            fail("GIS_CRS_CONFLICT", "Choose either a source CRS or local control-point georeferencing.")
        transform, local_details = local_transform(local)
        source_label, source_wkt, operation = "Local engineering coordinates", None, "Explicit 2D similarity fitted to control points"
    else:
        chosen = recipe.get("sourceCrs", {"kind": "file"})
        if chosen["kind"] == "epsg":
            source = osr.SpatialReference()
            source.ImportFromEPSG(chosen["code"])
        else:
            source = layer["srs"]
        if source is None:
            fail("GIS_CRS_REQUIRED", "Identify the source CRS or supply local DXF control points. Units alone do not georeference a drawing.")
        if source.IsCompound() or (not source.IsProjected() and not source.IsGeographic()):
            fail("GIS_UNSUPPORTED_CRS", "Choose a supported horizontal geographic or projected CRS.")
        if fmt == "dxf":
            if not source.IsProjected() or abs(source.GetLinearUnits()-UNIT_METERS[recipe["dxf"]["units"]]) > 1e-9:
                fail("GIS_UNIT_MISMATCH", "DXF drawing units must match the selected projected CRS units.")
        ct = transform_pair(source, target)
        transform = lambda x,y: ct.TransformPoint(x,y)[:2]
        source_wkt = source.ExportToWkt()
        info = crs_info(source)
        source_label = info["authority"] or "File WKT"
        operation = "Offline PROJ horizontal transformation; traditional GIS XY; only best; no ballpark"
    rows = layer["rows"]
    selected_ids = recipe.get("dxf", {}).get("entityIds")
    if selected_ids is not None and (not selected_ids or len(set(selected_ids)) != len(selected_ids)):
        fail("GIS_SELECTION", "Select at least one unique CAD entity ID.")
    if selected_ids is not None and not set(selected_ids).issubset({r["id"] for r in rows}):
        fail("GIS_SELECTION", "A selected CAD entity is absent.")
    rows = [r for r in rows if selected_ids is None or r["id"] in selected_ids]
    if len(rows) > FEATURE_LIMIT:
        fail("GIS_TOO_LARGE", "The selected layer exceeds 5,000 features. No features were omitted.")
    excluded, output, total_vertices = collections.Counter(), [], 0
    all_count = sum(len(l["rows"]) for l in layers)
    excluded["Unselected layers or entities"] = all_count - len(rows)
    warnings = []
    for index, row in enumerate(rows):
        if not supported(row):
            excluded["Unsupported, non-footprint or paper-space entity"] += 1
            continue
        g = row["geometry"]
        if g.IsEmpty() or not g.IsValid():
            fail("GIS_INVALID_GEOMETRY", f"Selected feature {index + 1} has invalid or empty geometry. No automatic repair was applied.")
        if g.Is3D() and not recipe.get("flattenZ", False):
            fail("GIS_Z_REVIEW_REQUIRED", "The source contains Z coordinates. Explicitly review flattening to 2D before importing footprints.")
        raw = json.loads(g.ExportToJson())
        def convert_coords(value):
            nonlocal total_vertices
            if isinstance(value, list) and value and isinstance(value[0], (int,float)):
                total_vertices += 1
                if total_vertices > VERTEX_LIMIT:
                    fail("GIS_TOO_LARGE", "The normalized geometry exceeds 50,000 vertices. No simplification or truncation was applied.")
                x,y = transform(value[0],value[1])
                if not all(math.isfinite(v) for v in (x,y)) or not -180 <= x <= 180 or not -90 <= y <= 90:
                    fail("GIS_TRANSFORMATION_FAILED", "A coordinate cannot be transformed into valid WGS84 longitude/latitude.")
                return [x,y]
            return [convert_coords(item) for item in value]
        geometry = {"type": raw["type"], "coordinates": convert_coords(raw["coordinates"])}
        transformed = ogr.CreateGeometryFromJson(json.dumps(geometry))
        if transformed.IsEmpty() or not transformed.IsValid():
            fail("GIS_INVALID_GEOMETRY", "Reprojection produced invalid geometry; no automatic repair was applied.")
        output.append({"type":"Feature", "id":row["id"], "geometry":geometry, "properties":row["properties"]})
    exclusions = [{"count": n,"reason": reason} for reason,n in excluded.items() if n]
    if exclusions and not recipe.get("acknowledgeExcluded",False):
        fail("GIS_EXCLUSIONS_REVIEW_REQUIRED", "Review and explicitly acknowledge the unselected or unsupported entity counts before preparing this layer.")
    if not output:
        fail("GIS_NO_FOOTPRINTS", "No supported footprint polygons remain in the selected layer.")
    if recipe.get("flattenZ"):
        warnings.append("Z coordinates were explicitly flattened for this 2D planning import; original bytes are retained.")
    if fmt == "dxf":
        warnings.append("CAD curves may be tessellated using the recorded maximum segment gap and 1-degree angular step; original curve definitions remain in the retained DXF. No surveyed accuracy is implied.")
    if local_details:
        warnings.append("Control-point georeferencing is an authored placement assumption. Two fitted points alone provide no independent accuracy check.")
        if abs(local_details["scaleMetersPerSourceUnit"]/UNIT_METERS[recipe["dxf"]["units"]]-1)>0.01:
            warnings.append("The fitted scale differs by more than 1% from the declared drawing-unit scale. Review the control points and unit declaration; fitted placement controls this conversion.")
    geojson = {"type":"FeatureCollection","features":output}
    provenance_recipe = dict(recipe)
    if provenance_recipe.get("dxf") and "entityIds" in provenance_recipe["dxf"]:
        provenance_recipe["dxf"]={k:v for k,v in provenance_recipe["dxf"].items() if k!="entityIds"}
        provenance_recipe["entitySelectionSha256"]=digest(canonical(selected_ids))
    if local_details:
        provenance_recipe["controlTransformResult"] = local_details
    provenance = {"version":1,"format":fmt,"upload":{"name":request.get("filename") or f"source.{fmt}",**input_info},"selection":{"layer":layer["id"],**({"entityIds":selected_ids} if selected_ids is not None else {})},"crs":{"source":source_label,**({"sourceWkt":source_wkt} if source_wkt else {}),"axisOrder":"xy","coordinateUnit":recipe.get("dxf",{}).get("units") or (crs_info(source) or {}).get("unit") or "unknown","target":"OGC:CRS84"},"operation":{"name":operation,"accuracyMeters":None},"converter":converter,"normalizedSha256":digest(canonical(geojson)),"recipe":provenance_recipe,"exclusions":exclusions}
    diagnostics = {"inputFeatures":all_count,"selectedFeatures":len(rows),"outputFeatures":len(output),"excludedFeatures":sum(v["count"] for v in exclusions),"vertices":total_vertices,"warnings":warnings}
    if local_details:
        diagnostics.update({k:local_details[k] for k in ("controlResidualsMeters","checkpointResidualsMeters")})
    return {"version":1,"geojson":geojson,"provenance":provenance,"diagnostics":diagnostics}


def export_shapefile(request):
    root = pathlib.Path("/tmp/export")
    root.mkdir(mode=0o700)
    manifest = dict(request.get("manifest", {}))
    inventory, total_vertices, total_features = [], 0, 0
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    for layer in request["layers"]:
        name = layer["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", name):
            fail("GIS_EXPORT_LAYER", "Export layer IDs must be safe fixed identifiers.")
        features = layer["geojson"]["features"]
        if not features:
            continue
        types = {f["geometry"]["type"] for f in features}
        polygon = types.issubset({"Polygon","MultiPolygon"})
        line = types.issubset({"LineString","MultiLineString"})
        if not polygon and not line:
            fail("GIS_EXPORT_GEOMETRY", "Each Shapefile layer must contain only polygon or only line geometry.")
        ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(str(root / f"{name}.shp"))
        dest = ds.CreateLayer(name,srs,ogr.wkbPolygon if polygon else ogr.wkbLineString,options=["ENCODING=UTF-8","2GB_LIMIT=YES"])
        fields = [("GIS_ID",ogr.OFTString,64),("NAME",ogr.OFTString,254),("NAME_FULL",ogr.OFTInteger,1),("SRC_ID",ogr.OFTString,254),("SRC_FULL",ogr.OFTInteger,1),("SRC_REF",ogr.OFTString,254),("REF_FULL",ogr.OFTInteger,1),("REVISION",ogr.OFTInteger64,18)]
        quantities = (("height","HEIGHT_M","HGT_NULL"),("floors","FLOORS","FLR_NULL"),("units","HOMES","UNIT_NULL"),("jobs","JOBS","JOB_NULL"),("parkingSpaces","PARKING","PARK_NULL"))
        for prop, short, flag in quantities:
            fields += [(short,ogr.OFTReal,24),(flag,ogr.OFTInteger,1),(flag.replace("NULL","STAT"),ogr.OFTString,16)]
        for key,typ,width in fields:
            field = ogr.FieldDefn(key,typ); field.SetWidth(width)
            if typ == ogr.OFTReal: field.SetPrecision(10)
            dest.CreateField(field)
        ids=[]
        for index,feature in enumerate(features):
            geometry = ogr.CreateGeometryFromJson(json.dumps(feature["geometry"]))
            total_vertices += vertices(geometry);total_features+=1
            if total_vertices > VERTEX_LIMIT or total_features > FEATURE_LIMIT:
                fail("GIS_TOO_LARGE", "The geometry export exceeds 5,000 features or 50,000 vertices. No records were omitted.")
            if geometry is None or geometry.IsEmpty() or not geometry.IsValid():
                fail("GIS_EXPORT_GEOMETRY", "Invalid export geometry cannot be repaired silently.")
            props = feature.get("properties") or {}
            identifier = str(feature.get("id", props.get("id", index)))
            gis_id = digest(identifier.encode("utf8"))
            ids.append({"GIS_ID":gis_id,"sourceId":identifier,"featureIndex":index})
            out=ogr.Feature(dest.GetLayerDefn());out.SetGeometry(geometry);out.SetField("GIS_ID",gis_id)
            for prop,key,flag in (("name","NAME","NAME_FULL"),("sourceId","SRC_ID","SRC_FULL"),("sourceFeatureId","SRC_REF","REF_FULL")):
                value=str(props.get(prop) or "")
                full=len(value.encode("utf8"))>254
                out.SetField(key,"See exact JSON sidecar" if full else value);out.SetField(flag,int(full))
            out.SetField("REVISION",int(props.get("scenarioRevision",props.get("revision",0))))
            for prop,key,flag in quantities:
                value=props.get(prop);out.SetField(flag,int(value is None))
                status=props.get("attributeProvenance",{}).get("fields",{}).get(prop,{}).get("status") or ("missing" if value is None else "legacy")
                if status not in ("supplied","derived","assumed","missing","legacy"):fail("GIS_EXPORT_ATTRIBUTE","A quantity has an unsupported evidence status.")
                out.SetField(flag.replace("NULL","STAT"),status)
                if value is not None:
                    if not isinstance(value,(int,float)) or not math.isfinite(value) or abs(value)>=1e12:
                        fail("GIS_EXPORT_ATTRIBUTE", "A quantity cannot be represented safely in the Shapefile numeric field. Use exact JSON.")
                    out.SetField(key,float(value))
            dest.CreateFeature(out)
        ds=None
        (root/f"{name}.exact.geojson").write_bytes(canonical(layer["geojson"]))
        inventory.append({"layer":name,"features":len(features),"geometry":"Polygon" if polygon else "LineString","fieldDictionary":{"GIS_ID":"SHA-256 of exact feature ID; join via featureIndex/ID manifest and exact GeoJSON","NAME":"name","NAME_FULL":"1 means full text retained only in exact GeoJSON","SRC_ID":"sourceId","SRC_FULL":"1 means full source ID retained only in exact GeoJSON","SRC_REF":"sourceFeatureId","REF_FULL":"1 means full source reference retained only in exact GeoJSON","REVISION":"saved scenario revision","HEIGHT_M":"height in meters","FLOORS":"floors","HOMES":"units","JOBS":"jobs","PARKING":"parkingSpaces","*_NULL":"1 means unknown or not applicable; never interpret the numeric DBF placeholder as zero","*_STAT":"supplied, derived, assumed, missing or legacy (no authored field-level evidence); exact evidence is retained in JSON"},"featureIds":ids,"exactSidecar":f"{name}.exact.geojson"})
    if not inventory:
        fail("GIS_EXPORT_EMPTY", "There is no materialized geometry to export.")
    manifest.update({"version":1,"crs":"OGC:CRS84 / WGS84 longitude-latitude","layers":inventory,"notes":["DBF supports only a flat, bounded attribute subset. Full programs, statuses, provenance, Unicode text and nested properties are retained in exact GeoJSON sidecars.","*_NULL flags are authoritative for missing quantities. Numeric DBF precision is 10 decimal places; exact numbers remain in sidecars.","The export is planning geometry, not a cadastral survey or legal boundary certification."]})
    manifest["files"]=[{"name":p.name,"sha256":digest(p.read_bytes()),"bytes":p.stat().st_size} for p in sorted(root.iterdir()) if p.is_file()]
    (root/"manifest.json").write_bytes(canonical(manifest))
    if sum(p.stat().st_size for p in root.iterdir())>EXPANDED_LIMIT:
        fail("GIS_TOO_LARGE","The generated archive exceeds 100 MiB expanded; no file was omitted.")
    zip_path=pathlib.Path("/out/export.zip")
    with zipfile.ZipFile(zip_path,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for p in sorted(root.iterdir()):
            info=zipfile.ZipInfo(p.name,date_time=(2020,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100600<<16
            archive.writestr(info,p.read_bytes())
    if zip_path.stat().st_size>EXPANDED_LIMIT:
        fail("GIS_TOO_LARGE","The generated Shapefile archive exceeds 100 MiB.")
    return {"manifest":manifest,"bytes":zip_path.stat().st_size,"sha256":digest(zip_path.read_bytes())}


def main():
    request=json.loads(read_bounded(pathlib.Path("/input/request.json"),EXPANDED_LIMIT))
    if request["operation"]=="export":
        return export_shapefile(request)
    path=pathlib.Path("/input/source")
    raw=read_bounded(path,INPUT_LIMIT)
    converter={"name":"GDAL/PROJ","version":gdal.VersionInfo("RELEASE_NAME"),"projVersion":f"{osr.GetPROJVersionMajor()}.{osr.GetPROJVersionMinor()}.{osr.GetPROJVersionMicro()}","imageDigest":request["imageDigest"]}
    layers,members=records(path,request["format"],request.get("recipe"))
    if len(layers)>100:
        fail("GIS_TOO_LARGE","The dataset exceeds 100 selectable layers.")
    info={"sha256":digest(raw),"bytes":len(raw),"members":members}
    if request["operation"]=="inspect":
        warnings=[]
        if request["format"]=="dxf":warnings.append("DXF units alone do not define a location. Choose a projected source CRS or explicit control-point georeferencing. Blocks are not expanded; unsupported entities are counted.")
        inspection={"version":1,"format":request["format"],"input":info,"converter":converter,"layers":[describe_layer(layer) for layer in layers],"warnings":warnings}
        if len(canonical(inspection))>1024**2:
            fail("GIS_INSPECTION_LIMIT","The inspection inventory exceeds 1 MiB. Split the source into fewer layers/fields; no inventory entries were omitted.")
        return inspection
    if request["operation"]=="normalize":
        return normalize(layers,request,info,converter)
    fail("GIS_OPERATION","Unsupported GIS operation.")


try:
    response={"ok":True,"result":main()}
except Rejected as error:
    response={"ok":False,"error":{"code":error.code,"message":str(error)}}
except Exception:
    # Native/parser exceptions may contain private paths, fields or untrusted text.
    response={"ok":False,"error":{"code":"GIS_CONVERSION_FAILED","message":"The GIS source could not be processed safely. Check its format, CRS, geometry and components."}}
data=canonical(response)
if len(data)>EXPANDED_LIMIT:
    data=canonical({"ok":False,"error":{"code":"GIS_TOO_LARGE","message":"The normalized response exceeds 100 MiB."}})
pathlib.Path("/out/response.json").write_bytes(data)
