#!/usr/bin/env python3
"""Offline worker: trusted declarative JSON -> pinned SUMO XML and exact outputs.
No client paths, commands, SQL, scripts, remote resources, or SUMO config accepted.
"""
import hashlib
import gzip
import gc
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from functools import reduce

sys.path.insert(0, '/usr/share/sumo/tools')
import sumolib

IN, OUT = Path('/input'), Path('/output')
CLASSES = ('passenger', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian')
MAX_OUTPUT = 256 * 1024**2
START = time.monotonic()
LOGS = []


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')))


def xml(path):
    raw = path.read_bytes()
    if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
        raise ValueError('External XML declarations are not supported.')
    return ET.fromstring(raw)


def canonical_network(path):
    # SUMO inserts wall-clock comments. Keep the original evidence and make the
    # graph identity independent of those comments without changing elements.
    raw = path.read_text()
    path.with_name(path.stem + '.raw.xml.gz').write_bytes(gzip.compress(raw.encode(),mtime=0))
    path.write_text(ET.canonicalize(raw, with_comments=False, strip_text=True))


def command(args, label):
    remaining = max(1, 165 - (time.monotonic()-START))
    log = OUT / (label + '.log')
    with log.open('wb') as stream:
        p = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT,
                           timeout=remaining, env={**os.environ, 'PROJ_NETWORK': 'OFF'})
    if log.stat().st_size > 1024**2:
        raise ValueError('Native diagnostic output exceeded 1 MiB; output not accepted.')
    LOGS.append(log.name)
    if p.returncode:
        # The bounded log is retained privately by the runtime; no arbitrary source
        # text or private operator paths become an HTTP error message.
        raise ValueError('Native ' + args[0] + ' rejected the input; inspect the retained bounded diagnostic log.')


def shape_geo(net, shape):
    return [list(net.convertXY2LonLat(p[0], p[1])) for p in shape]


def graph(path, sources, options, bounds, notes, source_files, source_identity_version=2):
    root = xml(path)
    net = sumolib.net.readNet(str(path), withInternal=True, withPrograms=True)
    source_ids = [s['id'] for s in sources]
    edge_xml = {e.get('id'): e for e in root.findall('edge') if e.get('function') != 'internal'}
    edges = []
    vertices = 0
    for edge in net.getEdges():
        if edge.getID() not in edge_xml:
            continue
        raw = edge_xml[edge.getID()]
        original = next((p.get('value', '') for p in raw.findall('param') if p.get('key') == 'origId'), '')
        if source_identity_version == 1:
            # Preserve the exact inventory of existing immutable v1 captures.
            ways = original.split() or [edge.getID().lstrip('-').split('#')[0]]
        else:
            lane_originals = [p.get('value', '') for lane in raw.findall('lane') for p in lane.findall('param') if p.get('key') == 'origId']
            ways = list(dict.fromkeys(original.split() + [token for value in lane_originals for token in value.split()]))
            if not ways:
                ways = [edge.getID().lstrip('-').split('#')[0]]
        lanes = []
        for lane in edge.getLanes():
            points = shape_geo(net, lane.getShape())
            vertices += len(points)
            lanes.append({'id': lane.getID(), 'index': lane.getIndex(), 'shape': points,
                          'lengthMeters': lane.getLength(), 'speedMps': lane.getSpeed(),
                          'allowedClasses': [c for c in CLASSES if lane.allows(c)],
                          'quality': 'inferred', 'sourceIds': source_ids})
        edges.append({'id': edge.getID(), 'from': edge.getFromNode().getID(), 'to': edge.getToNode().getID(),
                      'sourceWayIds': ways, 'lanes': lanes, 'quality': 'inferred', 'sourceIds': source_ids})
    if len(edges) > 30000 or sum(len(e['lanes']) for e in edges) > 50000 or vertices > 500000:
        raise ValueError('Prepared network exceeds bounded topology limits: '+str(len(edges))+' edges, '+str(sum(len(e['lanes']) for e in edges))+' lanes, '+str(vertices)+' vertices; no features were omitted.')
    edge_ids = {e['id'] for e in edges}
    edge_to_node = {e['id']: e['to'] for e in edges}
    node_ids = {e[k] for e in edges for k in ('from', 'to')}
    nodes = []
    for node in net.getNodes():
        if node.getID() not in node_ids:
            continue
        kind = node.getType()
        if kind not in ('priority', 'traffic_light', 'allway_stop', 'right_before_left', 'dead_end'):
            kind = 'unknown'
        external = not any(e.getID() in edge_ids for e in node.getIncoming()) or not any(e.getID() in edge_ids for e in node.getOutgoing())
        nodes.append({'id': node.getID(), 'position': list(net.convertXY2LonLat(*node.getCoord()[:2])),
                      'type': kind, 'external': external, 'quality': 'inferred', 'sourceIds': source_ids})
    connections, signals = [], []
    connection_ids = set()
    for c in root.findall('connection'):
        if c.get('from') not in edge_ids or c.get('to') not in edge_ids:
            continue
        # netconvert may reorder XML connections after an overlay. Bind the
        # identity to the actual external movement, never enumeration order.
        movement = [c.get('from'), c.get('to'), c.get('fromLane'), c.get('toLane')]
        cid = 'connection-' + digest(json.dumps(movement,separators=(',',':')).encode())[:32]
        if cid in connection_ids:
            raise ValueError('Duplicate external lane movement identity.')
        connection_ids.add(cid)
        item = {'id': cid, 'fromEdge': c.get('from'), 'toEdge': c.get('to'),
                'fromLane': c.get('from')+'_'+c.get('fromLane'), 'toLane': c.get('to')+'_'+c.get('toLane'),
                'viaLaneIds': c.get('via', '').split(),
                'direction': {'l':'left','L':'left','r':'right','R':'right','s':'straight','t':'uturn'}.get(c.get('dir'),'unknown'),
                'quality': 'inferred', 'sourceIds': source_ids}
        if c.get('tl'):
            item.update(signalId=c.get('tl'), signalIndex=int(c.get('linkIndex')))
        connections.append(item)
    if len(connections) > 100000:
        raise ValueError('Network connection limit exceeded.')
    for signal in root.findall('tlLogic'):
        phases = [{'durationSeconds': float(p.get('duration')), 'state': p.get('state')} for p in signal.findall('phase')]
        if not phases:
            raise ValueError('Signal without phases.')
        linked = [c for c in connections if c.get('signalId') == signal.get('id')]
        slots = [[] for _ in phases[0]['state']]
        for c in linked:
            if c['signalIndex'] >= len(slots):
                raise ValueError('Signal index exceeds phase state length.')
            slots[c['signalIndex']].append(c['id'])
        signals.append({'id': signal.get('id'), 'nodeIds': sorted({edge_to_node[c['fromEdge']] for c in linked}),
                        'programId': signal.get('programID'), 'offsetSeconds': float(signal.get('offset', '0')),
                        'connectionIds': slots, 'phases': phases, 'quality': 'inferred', 'sourceIds': source_ids})
    raw = path.read_bytes()
    warnings = []
    for log in LOGS:
        warnings.extend(line for line in (OUT/log).read_text().splitlines() if line.startswith(('Warning:', 'Error:')))
    actual_bounds = [min(n['position'][0] for n in nodes), min(n['position'][1] for n in nodes),
                     max(n['position'][0] for n in nodes), max(n['position'][1] for n in nodes)]
    manifest = {'engine': {'name':'sumo','version':'1.26.0','imageDigest': REQUEST['imageDigest']},
                'networkFileSha256': digest(raw), 'sourceFiles': source_files, 'sources': sources,
                'conversion': {'version':'urban-traffic-net-'+str(source_identity_version)+':'+REQUEST['workerSha256'],'options':options,'warnings':warnings},
                'bounds':actual_bounds, 'notes':notes + [
                    'Requested source envelope: ' + json.dumps(bounds) + '; complete crossing ways extend the actual network bounds.',
                    'Source topology retains OSM nodes, grade separation and supported turn restrictions. Lane connections and signal programs are inferred by netconvert, not observed signal timing.',
                    'External ports are graph endpoints, not an assertion that all external demand is known.',
                    'Lane and connection inventory is complete for the supported motor-traffic network; pedestrian-only/cycle-only ways are outside this runtime profile.']}
    return {'version':1,'id':'sumo-'+digest(raw)[:24], 'manifest':manifest,'nodes':nodes,'edges':edges,'connections':connections,'signals':signals}


def prepare():
    options = ['--osm-files','/input/source.osm.xml','--output.original-names','true',
               '--osm.all-attributes','true','--geometry.remove','true','--output.removed-nodes','true',
               '--keep-edges.by-vclass','passenger,truck,bus,motorcycle,bicycle',
               '--tls.default-type','static','--xml-validation','never',
               '--no-turnarounds','true','--precision','6']
    command(['netconvert', *options, '-o', str(OUT/'network.net.xml')], 'netconvert')
    if REQUEST.get('serviceAccessPolicyJSON') is not None:
        options = service_access(OUT/'network.net.xml', options)
    canonical_network(OUT/'network.net.xml')
    result = graph(OUT/'network.net.xml', REQUEST['sources'], options, REQUEST['bounds'], REQUEST.get('notes', []), REQUEST['sourceFiles'])
    write_json(OUT/'response.json', result)


def native_way_ids(edge):
    values = [p.get('value', '') for p in edge.findall('param') if p.get('key') == 'origId']
    values += [p.get('value', '') for lane in edge.findall('lane') for p in lane.findall('param') if p.get('key') == 'origId']
    return sorted(set(token for value in values for token in value.split()))


def permission_attributes(lane):
    return {k: lane.get(k) for k in ('allow', 'disallow') if lane.get(k) is not None}


def allows(attributes, vehicle_class):
    if 'allow' in attributes:
        values = attributes['allow'].split()
        return 'all' in values or vehicle_class in values
    excluded = attributes.get('disallow', '').split()
    return 'all' not in excluded and vehicle_class not in excluded


def service_access(path, original_options):
    """Only explicit source preflight can change passenger access; regenerate internal lanes."""
    policy_json = REQUEST['serviceAccessPolicyJSON']
    policy = json.loads(policy_json)
    if policy.get('version') != 1 or policy.get('policy') != 'infer-unrestricted-service-passenger' or policy.get('sourceSha256') != digest((IN/'source.osm.xml').read_bytes()):
        raise ValueError('The service-access preflight does not match the exact OSM source.')
    (OUT/'source-access-policy.json').write_text(policy_json)
    eligible = set(policy['eligibleServiceWayIds'])
    denied = {r['wayId'] for r in policy['passengerRestrictedWays']}
    if eligible.intersection(denied):
        raise ValueError('A restricted source way cannot be eligible for service passenger access.')
    root = xml(path)
    patch = ET.Element('edges')
    changes = []
    skipped_eligible_lanes = []
    for edge in root.findall('edge'):
        if edge.get('function') == 'internal':
            continue
        ways = native_way_ids(edge)
        deny = bool(denied.intersection(ways))
        enable = bool(ways) and all(w in eligible for w in ways) and not deny
        if not (deny or enable):
            continue
        patch_edge = None
        for lane in edge.findall('lane'):
            before = permission_attributes(lane)
            wanted = not deny
            if allows(before, 'passenger') == wanted:
                continue
            if enable and set(before.get('allow', '').split()) != {'delivery', 'pedestrian', 'bicycle'}:
                skipped_eligible_lanes.append({'edgeId': edge.get('id'), 'laneId': lane.get('id'), 'sourceWayIds': ways,
                    'permissions': before, 'reason': 'Only the pinned default service motor-lane permission set may gain passenger access; specialized lanes are withheld.'})
                continue
            if 'allow' in before:
                permitted = before['allow'].split()
                if 'all' in permitted:
                    after = {'disallow': 'passenger'} if deny else before
                else:
                    permitted = [c for c in permitted if c != 'passenger'] + (['passenger'] if enable else [])
                    after = {'allow': ' '.join(permitted)} if permitted else {'disallow': 'all'}
            else:
                excluded = before.get('disallow', '').split()
                if 'all' in excluded:
                    after = {'allow': 'passenger'} if enable else before
                else:
                    excluded = [c for c in excluded if c != 'passenger'] + (['passenger'] if deny else [])
                    after = {'disallow': ' '.join(excluded)} if excluded else {'allow': 'all'}
            if patch_edge is None:
                patch_edge = ET.SubElement(patch, 'edge', {'id': edge.get('id')})
            ET.SubElement(patch_edge, 'lane', {'index': lane.get('index'), **after})
            changes.append({'edgeId': edge.get('id'), 'laneId': lane.get('id'), 'sourceWayIds': ways,
                            'action': 'deny' if deny else 'infer-service-passenger', 'before': before, 'after': after})
    base = OUT/'service-base.net.xml'
    path.rename(base)
    canonical_network(base)
    base_hash = digest(base.read_bytes())
    ET.ElementTree(patch).write(OUT/'service-access.edg.xml', encoding='utf-8', xml_declaration=True)
    del root, patch
    gc.collect()
    options = ['--sumo-net-file', str(base), '--edge-files', str(OUT/'service-access.edg.xml'),
               '--output.original-names', 'true', '--no-turnarounds', 'true', '--precision', '6', '--xml-validation', 'never']
    command(['netconvert', *options, '-o', str(path)], 'service-access-netconvert')
    actual = xml(path)
    lanes = {l.get('id'): l for e in actual.findall('edge') if e.get('function') != 'internal' for l in e.findall('lane')}
    for change in changes:
        lane = lanes.get(change['laneId'])
        if lane is None:
            raise ValueError('Access conversion removed an original lane.')
        attributes = permission_attributes(lane)
        tokens = set(' '.join([*change['before'].values(), *change['after'].values(), *attributes.values()]).split())
        for cls in (tokens - {'all', 'passenger'}) | {'__other__'}:
            if allows(attributes, cls) != allows(change['before'], cls):
                raise ValueError('Access conversion changed a vehicle class other than passenger.')
        if allows(attributes, 'passenger') != (change['action'] == 'infer-service-passenger'):
            raise ValueError('Access conversion did not implement the exact passenger policy.')
    for edge in actual.findall('edge'):
        if denied.intersection(native_way_ids(edge)) and any(allows(permission_attributes(l), 'passenger') for l in edge.findall('lane')):
            raise ValueError('A captured source access restriction regained passenger permission.')
    write_json(OUT/'applied-access-policy.json', {'version': 1, 'sourcePolicySha256': digest(policy_json.encode()),
        'originalOptions': original_options, 'originalNativeSha256': base_hash, 'options': options, 'changes': changes, 'skippedEligibleLanes': skipped_eligible_lanes,
        'notes': ['Only passenger class permissions are intentionally changed.', 'Internal lane permissions are regenerated by pinned netconvert.',
                  'This conservative source-tag policy is inferred access, not verified legal or field access.']})
    return options


def endpoint_attributes(vehicle, edges):
    endpoints = vehicle.get('endpoints')
    if endpoints is None:
        return {}
    first = edges.get(vehicle['edges'][0])
    last = edges.get(vehicle['edges'][-1])
    depart = next((l for l in first['lanes'] if l['id'] == endpoints['departLaneId']), None) if first else None
    arrival = next((l for l in last['lanes'] if l['id'] == endpoints['arrivalLaneId']), None) if last else None
    if depart is None or arrival is None or vehicle['vehicleClass'] not in depart['allowedClasses'] or vehicle['vehicleClass'] not in arrival['allowedClasses']:
        raise ValueError('An explicit route endpoint no longer has its permitted native lane.')
    if not 0 <= endpoints['departPositionMeters'] < depart['lengthMeters'] or not 0 <= endpoints['arrivalPositionMeters'] <= arrival['lengthMeters']:
        raise ValueError('An explicit route position exceeds its native lane; no endpoint was relocated.')
    if len(vehicle['edges']) == 1 and (depart['id'] != arrival['id'] or endpoints['arrivalPositionMeters'] <= endpoints['departPositionMeters']):
        raise ValueError('A single-edge route must move forward on the same native lane.')
    return {'departLane':str(depart['index']), 'departPos':str(endpoints['departPositionMeters']),
            'arrivalLane':str(arrival['index']), 'arrivalPos':str(endpoints['arrivalPositionMeters'])}


def create_routes(vehicles, path, network):
    root = ET.Element('routes')
    edges = {e['id']:e for e in network['edges']}
    for cls in CLASSES:
        if cls != 'pedestrian':
            ET.SubElement(root,'vType', {'id':cls,'vClass':cls})
    for vehicle in sorted(vehicles, key=lambda v:(v['departSeconds'],v['id'])):
        item = ET.SubElement(root,'vehicle', {'id':vehicle['id'], 'type':vehicle['vehicleClass'],
                'depart':str(vehicle['departSeconds']), 'departLane':'best', 'departSpeed':'max',
                **endpoint_attributes(vehicle, edges)})
        ET.SubElement(item, 'route', {'edges':' '.join(vehicle['edges'])})
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)


def detectors(network, counts, period, side):
    root = ET.Element('additional')
    begin, end = period['beginSeconds']-period['warmupSeconds'], period['endSeconds']+period['cooldownSeconds']
    edges = {e['id']:e for e in network['edges']}
    connections = {c['id']:c for c in network['connections']}
    boundaries = [int(end-begin)] + [int(c[k]-begin) for c in counts for k in ('beginSeconds','endSeconds')]
    step = reduce(math.gcd, boundaries) or 1
    entries, predictions = {}, []
    for ci, count in enumerate(counts):
        target, classes = count['target'], count['vehicleClasses']
        if target is None or classes is None or count['status'] != 'available':
            predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'Count target, class mapping or observed value is unavailable.'})
            continue
        if 'pedestrian' in classes:
            predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'Person-count detection is outside this motor-traffic runtime; no pedestrian count was converted to vehicles.'})
            continue
        next_edge = None
        if target['kind'] == 'turn':
            c = connections.get(target['connectionId'])
            if c is None:
                predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'Turn is absent in this network.'})
                continue
            edge = edges[c['fromEdge']]
            lanes = [l for l in edge['lanes'] if l['id'] == c['fromLane']]
            if not c['viaLaneIds']:
                predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'This turn has no internal-edge detector binding.'})
                continue
            next_edge = c['viaLaneIds'][0].rsplit('_',1)[0]
            indistinguishable = [other for other in connections.values() if other['fromLane']==c['fromLane'] and other['viaLaneIds'] and other['viaLaneIds'][0].rsplit('_',1)[0]==next_edge]
            if len(indistinguishable) != 1:
                predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'This lane-level turn shares a detector internal edge with another connection; explicit movement aggregation is required.'})
                continue
            fraction = 1.0
        else:
            edge = edges.get(target['edgeId'])
            if edge is None:
                predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'Mapped edge is absent in this network.'})
                continue
            selected = target.get('laneIds')
            lanes = [l for l in edge['lanes'] if selected is None or l['id'] in selected]
            if selected is not None and len(lanes) != len(selected):
                predictions.append({'countId':count['id'],'vehicles':None,'status':'unavailable','reason':'Mapped lane set changed; explicit rematching is required.'})
                continue
            fraction = target['positionFraction']
        keys = []
        for li, lane in enumerate(lanes):
            key = 'detector-' + str(ci) + '-' + str(li)
            attr = {'id':key,'lane':lane['id'],'pos':str(lane['lengthMeters']*fraction),
                    'period':str(step),'file':str(OUT/(side+'-detectors.xml')),'vTypes':' '.join(classes),'friendlyPos':'false'}
            if next_edge: attr['nextEdges'] = next_edge
            ET.SubElement(root,'inductionLoop',attr)
            keys.append(key)
        entries[count['id']] = {'keys':keys,'begin':count['beginSeconds'],'end':count['endSeconds']}
    if sum(len(e['keys']) for e in entries.values()) * (end-begin)/step > 250000:
        raise ValueError('Exact count interval alignment exceeds 250,000 detector bins; split the run, no aggregation was approximated.')
    ET.SubElement(root,'edgeData',{'id':'edge-summary','begin':str(period['beginSeconds']), 'end':str(period['endSeconds']),
        'period':str(period['endSeconds']-period['beginSeconds']), 'file':str(OUT/(side+'-edges.xml')), 'excludeEmpty':'false'})
    for index, timing in enumerate(REQUEST.get('signalTimings', [])):
        ET.SubElement(root,'timedEvent',{'type':'SaveTLSStates','source':timing['signalId'],'dest':str(OUT/(side+'-signal-'+str(index)+'.xml'))})
    path = OUT/(side+'-additional.xml')
    ET.ElementTree(root).write(path,encoding='utf-8',xml_declaration=True)
    return path, entries, predictions


def simulate(side, network, net_path, vehicles, route_file):
    period = REQUEST['period']
    additional, entries, predictions = detectors(network,REQUEST['counts'],period,side)
    command(['sumo', '-n',str(net_path), '-r',str(route_file), '-a',str(additional),
        '--begin',str(period['beginSeconds']-period['warmupSeconds']), '--end',str(period['endSeconds']+period['cooldownSeconds']),
        '--seed',str(REQUEST['seed']), '--step-length','1', '--precision','6', '--xml-validation','never', '--no-step-log','true',
        '--time-to-teleport','-1', '--max-depart-delay','-1', '--collision.action','warn',
        '--tripinfo-output',str(OUT/(side+'-trips.xml')), '--tripinfo-output.write-unfinished','true',
        '--tripinfo-output.write-undeparted','true', '--vehroute-output',str(OUT/(side+'-routes.xml')),
        '--vehroute-output.write-unfinished','true','--vehroute-output.exit-times','true',
        '--statistic-output',str(OUT/(side+'-statistics.xml'))], side+'-sumo')
    stats = xml(OUT/(side+'-statistics.xml'))
    def statint(tag, field):
        node = stats.find(tag)
        return int(float(node.get(field,'0'))) if node is not None else 0
    trips_by_id = {}
    known = {v['id']:v for v in vehicles}
    for t in xml(OUT/(side+'-trips.xml')).findall('tripinfo'):
        def value(key):
            v = float(t.get(key, '-1'))
            return v if v >= 0 and math.isfinite(v) else None
        arrived = value('arrival') is not None and t.get('vaporized','') in ('','0','false')
        requested = known.get(t.get('id'))
        if requested and requested.get('endpoints'):
            endpoints = requested['endpoints']
            if value('depart') is not None and (t.get('departLane') != endpoints['departLaneId'] or value('departPos') is None or abs(value('departPos')-endpoints['departPositionMeters']) > 1e-5):
                raise ValueError('Executed departure differs from the requested native lane attachment.')
            if arrived and (t.get('arrivalLane') != endpoints['arrivalLaneId'] or value('arrivalPos') is None or abs(value('arrivalPos')-endpoints['arrivalPositionMeters']) > 1e-5):
                raise ValueError('Executed arrival differs from the requested native lane attachment.')
        trips_by_id[t.get('id')] = {'id':t.get('id'),'arrived':arrived,'departSeconds':value('depart'),
             'arrivalSeconds':value('arrival'),'durationSeconds':value('duration'), 'routeLengthMeters':value('routeLength'),
             'waitingSeconds':value('waitingTime'),'timeLossSeconds':value('timeLoss'), 'departDelaySeconds':value('departDelay')}
    missing = [v['id'] for v in vehicles if v['id'] not in trips_by_id]
    if missing:
        raise ValueError('Native trip output omitted submitted vehicles; no partial result accepted.')
    trips = [{**trips_by_id[v['id']], 'requestedDepartSeconds':v['departSeconds']} for v in vehicles]
    detector_path = OUT/(side+'-detectors.xml')
    records = {}
    if detector_path.exists():
        for interval in xml(detector_path).findall('interval'):
            records.setdefault(interval.get('id'), []).append((float(interval.get('begin')),float(interval.get('end')),int(interval.get('nVehContrib'))))
    for count_id, entry in entries.items():
        total = 0
        for key in entry['keys']:
            bins = [r for r in records.get(key,[]) if r[0] >= entry['begin'] and r[1] <= entry['end']]
            if not bins or abs(sum(b-a for a,b,_ in bins)-(entry['end']-entry['begin'])) > 1e-6:
                raise ValueError('Native detector coverage does not match the exact observed interval.')
            total += sum(v for _,_,v in bins)
        predictions.append({'countId':count_id,'vehicles':total,'status':'available'})
    result_edges = []
    for interval in xml(OUT/(side+'-edges.xml')).findall('interval'):
        for edge in interval.findall('edge'):
            def nullable(k):
                value = float(edge.get(k,'-1'))
                return value if value >= 0 else None
            result_edges.append({'edgeId':edge.get('id'),'beginSeconds':float(interval.get('begin')),'endSeconds':float(interval.get('end')),
                'entered':int(edge.get('entered','0')),'left':int(edge.get('left','0')),
                'meanSpeedMps':nullable('speed'),'meanTravelTimeSeconds':nullable('traveltime'),'sampledSeconds':float(edge.get('sampledSeconds','0'))})
    assigned = {v.get('id'):v.find('route').get('edges').split() for v in xml(route_file).findall('vehicle')}
    return {'version':1,'side':side,'seed':REQUEST['seed'],'period':period,
        'diagnostics': {'requested':len(vehicles),'loaded':statint('vehicles','loaded'),'inserted':statint('vehicles','inserted'),
            'arrived':sum(t['arrived'] for t in trips),'running':statint('vehicles','running'),'waiting':statint('vehicles','waiting'),
            'discarded':statint('vehicles','inserted')-sum(t['arrived'] for t in trips)-statint('vehicles','running'),'teleports':statint('teleports','total'),
            'collisions':statint('safety','collisions'),'routeErrors':0},
        'trips':trips,'predictions':predictions,'edges':result_edges,'assignedRoutes':assigned,
        'notes':['Microscopic simulation with explicit routes; not an observed OD matrix or a calibrated signal timing plan.',
                 'Teleports and maximum departure delay are disabled; unresolved congestion remains explicitly unfinished/uninserted.',
                 'Counts use completed E1 detector passages at the explicitly mapped lane position; lane changes at detectors can affect contributions.',
                 'Native timeLoss is delay below each vehicle’s desired speed, not Highway Capacity Manual control delay or LOS.']}


def captured_precision(options):
    precision = '2'
    for index, option in enumerate(options):
        if option == '--precision':
            if index + 1 >= len(options): raise ValueError('Missing captured network precision.')
            precision = options[index+1]
        elif option.startswith('--precision='):
            precision = option.split('=',1)[1]
        else:
            continue
        if precision not in ('2','6'): raise ValueError('Unsupported captured network precision.')
    return precision


def timing_programs(path, controls):
    programs = xml(path).findall('tlLogic')
    selected = []
    for control in controls:
        matches = [p for p in programs if p.get('id') == control['signalId']]
        if len(matches) != 1 or matches[0].get('programID') != control['programId']:
            raise ValueError('Signal program selection is absent or ambiguous.')
        program = matches[0]
        if (program.get('type') != 'static' or set(program.attrib)-{'id','type','programID','offset'} or
            any(child.tag != 'phase' or set(child.attrib)-{'duration','state','name'} for child in program)):
            raise ValueError('Signal timing supports only simple static programs without dynamic/branching attributes.')
        selected.append(program)
    return selected


def verify_timing_programs(before_path, after_path, controls):
    before = timing_programs(before_path, controls)
    after = timing_programs(after_path, controls)
    for control, original, actual in zip(controls, before, after):
        phases, actual_phases = original.findall('phase'), actual.findall('phase')
        if len(phases) != len(control['phaseDurationsSeconds']) or len(phases) != len(actual_phases):
            raise ValueError('Executed timing changed the phase sequence.')
        if {k:v for k,v in actual.attrib.items() if k != 'offset'} != {k:v for k,v in original.attrib.items() if k != 'offset'}:
            raise ValueError('Executed timing changed native controller attributes.')
        if float(actual.get('offset','0')) != control['offsetSeconds']:
            raise ValueError('Executed timing offset differs from the request.')
        for i, (phase, result) in enumerate(zip(phases, actual_phases)):
            expected = control['phaseDurationsSeconds'][i]
            if {k:v for k,v in result.attrib.items() if k != 'duration'} != {k:v for k,v in phase.attrib.items() if k != 'duration'} or float(result.get('duration')) != expected:
                raise ValueError('Executed timing state or duration differs from the request.')
            if expected != float(phase.get('duration')) and (not all(c in 'rRgG' for c in phase.get('state')) or not any(c in 'gG' for c in phase.get('state'))):
                raise ValueError('Clearance or non-green phase duration was changed.')


def pair():
    base = REQUEST['network']
    baseline_path = IN/'network.net.xml'
    source_identity_version = 1 if base['manifest']['conversion']['version'].startswith('urban-traffic-net-1:') else 2
    parsed = graph(baseline_path,base['manifest']['sources'],base['manifest']['conversion']['options'],
                   base['manifest']['bounds'],[],base['manifest']['sourceFiles'],source_identity_version)
    for field in ('nodes','edges','connections','signals'):
        if parsed[field] != base[field]:
            raise ValueError('Native graph inventory differs from the supplied topology; no result accepted.')
    proposed_path = baseline_path
    proposed = base
    vehicles = REQUEST['vehicles']
    create_routes(vehicles, OUT/'demand.rou.xml', base)
    proposal_routes = OUT/'demand.rou.xml'
    overlays = REQUEST['overlays']
    timings = REQUEST.get('signalTimings', [])
    original_programs = timing_programs(baseline_path, timings)
    if overlays or timings:
        patch = ET.Element('edges')
        closed = []
        for overlay in overlays:
            if overlay.get('closed'):
                closed.append(overlay['edgeId'])
                continue
            attributes = {'id':overlay['edgeId']}
            if 'lanes' in overlay: attributes['numLanes'] = str(overlay['lanes'])
            if 'speedMps' in overlay: attributes['speed'] = str(overlay['speedMps'])
            ET.SubElement(patch,'edge',attributes)
        ET.ElementTree(patch).write(OUT/'overlay.edg.xml',encoding='utf-8',xml_declaration=True)
        # Timing-only conversion preserves the captured geometry's serialization precision.
        # Raising old two-decimal geometry to six decimals reconstructs lane endpoints.
        precision = '6' if overlays else captured_precision(base['manifest']['conversion']['options'])
        options = ['--sumo-net-file',str(baseline_path),'--edge-files',str(OUT/'overlay.edg.xml'),'--xml-validation','never','--precision',precision]
        if timings:
            tls = ET.Element('tlLogics')
            for control, original in zip(timings, original_programs):
                program = ET.SubElement(tls,'tlLogic',{**original.attrib,'offset':str(control['offsetSeconds'])})
                for phase, duration in zip(original.findall('phase'),control['phaseDurationsSeconds']):
                    ET.SubElement(program,'phase',{**phase.attrib,'duration':str(duration)})
            ET.ElementTree(tls).write(OUT/'signal-timing.tll.xml',encoding='utf-8',xml_declaration=True)
            options += ['--tllogic-files',str(OUT/'signal-timing.tll.xml')]
        if closed: options += ['--remove-edges.explicit',','.join(closed)]
        proposed_path = OUT/'proposal.net.xml'
        command(['netconvert',*options,'-o',str(proposed_path)],'overlay-netconvert')
        canonical_network(proposed_path)
        verify_timing_programs(baseline_path,proposed_path,timings)
        proposed = graph(proposed_path,base['manifest']['sources'],options,base['manifest']['bounds'],
                         base['manifest']['notes']+['Proposal applies only explicit native edge controls and selected static signal timings; all retained controls are verified against output.'],base['manifest']['sourceFiles'],source_identity_version)
        proposed_edges = {e['id']:e for e in proposed['edges']}
        for v in vehicles:
            endpoint_attributes(v, proposed_edges)
        for program in proposed['signals']:
            if any(c['signalId'] == program['id'] for c in timings): program['quality'] = 'authored'
        if closed:
            for v in vehicles:
                if v['edges'][0] in closed or v['edges'][-1] in closed:
                    raise ValueError('A closure removes a demand origin/destination; explicitly revise the demand instead of silently relocating it.')
            proposal_routes = OUT/'proposal-assigned.rou.xml'
            repair_input = OUT/'proposal-repair-input.rou.xml'
            create_routes([{**v,'edges':[v['edges'][0],v['edges'][-1]] if any(edge in closed for edge in v['edges']) else v['edges']} for v in vehicles],repair_input,proposed)
            command(['duarouter','-n',str(proposed_path),'-r',str(repair_input),'-o',str(proposal_routes),
                     '--repair','true','--seed',str(REQUEST['seed']),'--precision','6','--xml-validation','never','--no-step-log','true'], 'proposal-route-repair')
            repaired = xml(proposal_routes).findall('vehicle')
            known = {v['id']:v for v in vehicles}
            if len(repaired) != len(vehicles) or {v.get('id') for v in repaired} != set(known):
                raise ValueError('Route repair did not preserve every original vehicle.')
            for v in repaired:
                original = known[v.get('id')]
                route = v.find('route').get('edges').split()
                if route[0] != original['edges'][0] or route[-1] != original['edges'][-1] or abs(float(v.get('depart'))-original['departSeconds']) > 1e-6:
                    raise ValueError('Route repair changed a demand endpoint or departure time.')
                for key, value in endpoint_attributes(original, proposed_edges).items():
                    if v.get(key) is None or abs(float(v.get(key))-float(value)) > 1e-6:
                        raise ValueError('Route repair changed an explicit native lane attachment.')
    baseline = simulate('baseline',base,baseline_path,vehicles,OUT/'demand.rou.xml')
    proposal = simulate('proposal',proposed,proposed_path,vehicles,proposal_routes)
    write_json(OUT/'response.json',{'baselineNetwork':base,'proposalNetwork':proposed,'baseline':baseline,'proposal':proposal})


try:
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_CPU,(170,170))
    resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_OUTPUT,MAX_OUTPUT))
    REQUEST = json.loads((IN/'request.json').read_text())
    if REQUEST['operation'] == 'prepare': prepare()
    elif REQUEST['operation'] == 'pair': pair()
    else: raise ValueError('Unknown native traffic operation.')
    if sum(p.stat().st_size for p in OUT.iterdir() if p.is_file()) > MAX_OUTPUT:
        raise ValueError('Total native traffic output exceeds 256 MiB; no partial result accepted.')
    peak_file = Path('/sys/fs/cgroup/memory.peak')
    peak = int(peak_file.read_text()) if peak_file.exists() else max(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)*1024
    write_json(OUT/'resources.json', {'wallMilliseconds':round((time.monotonic()-START)*1000), 'peakMemoryBytes':peak})
except Exception as error:
    write_json(OUT/'error.json',{'code':'TRAFFIC_NATIVE_REJECTED','message':str(error)[:1200]})
    sys.exit(1)
