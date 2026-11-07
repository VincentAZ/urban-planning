#!/usr/bin/env python3
"""Bounded, operator-only Arizona graph preparation. No other Docker services are modified."""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

IMAGE = 'ghcr.io/valhalla/valhalla@sha256:18cb42988e03c70dc4bc4ca095a259ec4db5e5df928be65956fc1c64c280b47a'
BASE = 'https://download.geofabrik.de/north-america/us/'
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / '.local/routing'
MEMORY = 8 * 1024**3
DISK = 20 * 1024**3
TIMEOUT = 1800
CPU = 2

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''):
            h.update(b)
    return h.hexdigest()

def disk_bytes(path):
    return sum(p.stat().st_size for p in path.rglob('*') if p.is_file())

def download(name, limit):
    destination = DATA / 'sources' / name
    meta = destination.with_suffix(destination.suffix+'.json')
    if destination.exists()!=meta.exists():
        raise RuntimeError('Source bytes and receipt must exist together; existing data is unchanged')
    if destination.exists() and meta.exists():
        if meta.stat().st_size>16384:
            raise RuntimeError('Existing source receipt exceeds its size cap')
        data = json.loads(meta.read_text())
        if data.get('url')!=BASE+name or type(data.get('bytes')) is not int or not 0<data['bytes']<=limit or not re.fullmatch(r'[a-f0-9]{64}',str(data.get('sha256',''))):
            raise RuntimeError('Existing source receipt has invalid provenance; existing data is unchanged')
        stamp=datetime.datetime.fromisoformat(data.get('retrievedAt','').replace('Z','+00:00'))
        if stamp.tzinfo is None or not isinstance(data.get('lastModified',''),str) or len(data.get('lastModified',''))>512:
            raise RuntimeError('Existing source receipt has invalid timestamps; existing data is unchanged')
        if destination.stat().st_size == data['bytes'] and digest(destination) == data['sha256']:
            print('Reusing verified source:', name, flush=True)
            return data
        raise RuntimeError('Existing source failed its checksum. Preserve it and investigate before retrying.')
    temp = destination.with_suffix(destination.suffix+'.part')
    url = BASE+name
    started = time.monotonic()
    request = urllib.request.Request(url, headers={'User-Agent':'UrbanPlanning-regional-graph/1.0 (operator-controlled single download)'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response, temp.open('wb') as out:
            if response.geturl()!=url:
                raise RuntimeError('Source download redirected outside its exact allowlisted URL')
            if int(response.headers.get('Content-Length', 0)) > limit:
                raise RuntimeError('Source exceeds download cap')
            count = 0
            while block := response.read(1024*1024):
                count += len(block)
                if count > limit or time.monotonic()-started > 900:
                    raise RuntimeError('Source exceeded byte/time cap')
                out.write(block)
            modified = response.headers.get('Last-Modified')
        if count == 0:
            raise RuntimeError('Source is empty')
        data = {'url':url,'sha256':digest(temp),'bytes':count,'retrievedAt':now()}
        if modified:
            data['lastModified'] = modified
        temp.replace(destination)
        meta.write_text(json.dumps(data, indent=2)+'\n')
        print('Captured source:', name, count, data['sha256'], flush=True)
        return data
    except BaseException:
        temp.unlink(missing_ok=True)
        raise

def polygon(path):
    # Geofabrik .poly: outer ring IDs and !hole IDs, each terminated by END.
    lines = iter(path.read_text().splitlines()[1:])
    parts = []
    for label in lines:
        label=label.strip()
        if label == 'END':
            break
        if not label:
            continue
        ring=[]
        for line in lines:
            if line.strip() == 'END':
                break
            coordinates=[float(v) for v in line.split()]
            if len(coordinates)!=2:
                raise RuntimeError('Invalid extract polygon')
            ring.append(coordinates)
        if ring[0]!=ring[-1]:
            ring.append(ring[0])
        if label.startswith('!'):
            if not parts:
                raise RuntimeError('Extract polygon hole precedes shell')
            parts[-1].append(ring)
        else:
            parts.append([ring])
    if not parts:
        raise RuntimeError('Extract polygon is empty')
    return {'type':'MultiPolygon','coordinates':parts}

def run_build(work, commands):
    name='urban-planning-routing-build-'+str(os.getpid())
    command=['docker','run','--name',name,'--label','urban-planning.routing=build','--network','none',
             '--cpus',str(CPU),'--memory',str(MEMORY),'--memory-swap',str(MEMORY),'--pids-limit','256',
             '--cap-drop','ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}',
             '-v',f'{work}:/data',IMAGE,'sh','-ec',commands]
    peak=0
    started=time.monotonic()
    with (work/'build.log').open('wb') as log:
        process=subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            while process.poll() is None:
                if time.monotonic()-started > TIMEOUT or disk_bytes(DATA)>DISK:
                    raise RuntimeError('Graph build exceeded time/disk cap')
                # cgroup usage is sampled; report measured sample maximum, not an invented exact peak.
                stats=subprocess.run(['docker','stats','--no-stream','--format','{{json .}}',name],capture_output=True,text=True,timeout=10)
                if stats.returncode==0 and stats.stdout.strip():
                    usage=json.loads(stats.stdout)['MemUsage'].split('/')[0].strip()
                    for unit,factor in [('GiB',1024**3),('MiB',1024**2),('KiB',1024),('B',1)]:
                        if usage.endswith(unit):
                            peak=max(peak,int(float(usage[:-len(unit)])*factor));break
                time.sleep(2)
            if process.returncode:
                raise RuntimeError(f'Native graph build failed ({process.returncode}); see {work}/build.log')
        finally:
            if process.poll() is None:
                subprocess.run(['docker','stop','-t','5',name],capture_output=True,timeout=15)
                process.wait(timeout=15)
            subprocess.run(['docker','rm',name],capture_output=True,timeout=15)
    return peak

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', action='store_true', help='Start the dedicated loopback-only service after preparing the graph')
    args=parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    for name in ['sources','builds','graphs','logs']:
        (DATA/name).mkdir(exist_ok=True)
    if shutil.disk_usage(DATA).free < DISK+2*1024**3:
        raise RuntimeError('At least 22 GiB free disk is required')
    if disk_bytes(DATA)>DISK:
        raise RuntimeError('Routing archive exceeds its 20GiB aggregate cap; archive reviewed old builds before preparing another graph')
    # Do not silently replace a graph underneath an already-running consumer.
    running=subprocess.run(['docker','inspect','-f','{{.State.Running}}','urban-planning-routing'],capture_output=True,text=True)
    if running.returncode==0 and running.stdout.strip()=='true':
        raise RuntimeError('Dedicated routing service is already running. Stop only that service before preparing/replacing its graph.')
    started_at=now(); started=time.monotonic()
    subprocess.run(['docker','pull',IMAGE],check=True,timeout=900)
    source=download('arizona-latest.osm.pbf',512*1024**2)
    boundary=download('arizona.poly',1024**2)
    key=hashlib.sha256((source['sha256']+boundary['sha256']+IMAGE+digest(Path(__file__))).encode()).hexdigest()[:16]
    target=DATA/'graphs'/('az-'+key)
    if target.exists() and not (target/'manifest.json').exists():
        raise RuntimeError('Existing graph directory has no manifest; existing files are unchanged')
    if not (target/'manifest.json').exists():
        work=DATA/'builds'/('az-'+key+'-'+str(os.getpid()))
        work.mkdir()
        os.link(DATA/'sources/arizona-latest.osm.pbf',work/'source.osm.pbf')
        config_output=subprocess.run(['docker','run','--rm','--network','none','--memory','512m','--cpus','1',IMAGE,
          'valhalla_build_config','--mjolnir-tile-dir','/data/tiles','--mjolnir-tile-extract','/data/tiles.tar',
          '--mjolnir-admin','/data/admins.sqlite','--mjolnir-timezone','/data/timezones.sqlite'],check=True,capture_output=True,timeout=60)
        config=json.loads(config_output.stdout)
        config['mjolnir']['concurrency']=CPU
        config['mjolnir']['max_cache_size']=256*1024**2
        config['mjolnir']['use_lru_mem_cache']=True
        config['mjolnir']['lru_mem_cache_hard_control']=True
        config['mjolnir']['global_synchronized_cache']=True
        config['thor']['source_to_target_algorithm']='timedistancematrix'
        config['thor']['clear_reserved_memory']=True
        config['thor']['max_reserved_labels_count_dijkstras']=100000
        config['loki']['actions']=['locate','sources_to_targets','isochrone','status']
        config['logging']['type']='std_out'
        config['loki']['service_defaults']['search_cutoff']=250
        config['service_limits']['max_radius']=250
        config['service_limits']['allow_hard_exclusions']=True
        for mode in ['auto','pedestrian']:
            config['service_limits'][mode]['max_matrix_location_pairs']=500
            config['service_limits'][mode]['max_matrix_distance']=500000
            config['service_limits'][mode]['max_locations']=500
        config['service_limits']['isochrone']['max_contours']=3
        config['service_limits']['isochrone']['max_time_contour']=45
        (work/'valhalla.json').write_text(json.dumps(config,sort_keys=True,indent=2)+'\n')
        peak=run_build(work,'valhalla_build_admins -c /data/valhalla.json /data/source.osm.pbf\nvalhalla_build_tiles -c /data/valhalla.json /data/source.osm.pbf\nvalhalla_build_extract -c /data/valhalla.json')
        graph_files=sorted(p for p in work.rglob('*') if p.is_file() and (p.suffix=='.gph' or p.name in ['admins.sqlite','tiles.tar']))
        if not graph_files or not (work/'tiles.tar').exists():
            raise RuntimeError('Native build did not produce a graph archive')
        inventory=[{'path':str(p.relative_to(work)),'sha256':digest(p),'bytes':p.stat().st_size} for p in graph_files]
        (work/'graph-files.json').write_text(json.dumps(inventory,sort_keys=True,indent=2)+'\n')
        graph_hash=hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        manifest={'version':1,'id':'az-'+key,'engine':{'name':'valhalla','version':'3.9.1','image':IMAGE,'imageDigest':IMAGE.split('@')[1]},
          'sources':[source,boundary],'graph':{'sha256':graph_hash,'bytes':sum(f['bytes']for f in inventory),'files':len(inventory)},
          'config':{'sha256':digest(work/'valhalla.json')},'profile':{'carTopSpeedKph':140,'walkingSpeedKph':5.1,'walkingBoundKph':10,'excludeWalkingFerries':True},'coverage':{'geometry':polygon(DATA/'sources/arizona.poly'),'maximumMinutes':45,'maximumSpeedKph':252,'maximumSnapMeters':250,'safetyMarginMeters':1000},
          'build':{'startedAt':started_at,'completedAt':now(),'wallSeconds':round(time.monotonic()-started,3),'peakMemoryBytes':peak,'cpuLimit':CPU,'memoryLimitBytes':MEMORY,'diskLimitBytes':DISK},
          'limitations':['Captured OpenStreetMap network only; authored scenario street edits are not represented.','Static modeled travel time, not observed congestion or scheduled transit.','No elevation or time-zone dataset; time-dependent routing is disabled.','Build memory is the maximum sampled Docker cgroup usage, not an exact instantaneous peak.','Origin and site snaps are bounded to 250 m; travel within that off-network gap is not added.','45-minute coverage uses enforced car140km/h or walking10km/h bounds plus both snaps and a1km margin; walking ferries are excluded.'],
          'credits':['© OpenStreetMap contributors; ODbL 1.0, https://www.openstreetmap.org/copyright','Extract supplied by Geofabrik, https://download.geofabrik.de/north-america/us/arizona.html','Valhalla 3.9.1, MIT license, https://github.com/valhalla/valhalla']}
        (work/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        work.rename(target)
    else:
        # Reusing a build must preserve the same integrity guarantee as API loading.
        manifest_path=target/'manifest.json'
        inventory_path=target/'graph-files.json'
        if manifest_path.stat().st_size>2_000_000 or inventory_path.stat().st_size>10_000_000:
            raise RuntimeError('Existing graph metadata exceeds its size cap')
        manifest=json.loads(manifest_path.read_text())
        inventory=json.loads(inventory_path.read_text())
        if manifest['engine']['image']!=IMAGE or manifest['sources']!=[source,boundary] or digest(target/'valhalla.json')!=manifest['config']['sha256']:
            raise RuntimeError('Existing graph provenance or configuration changed')
        if hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=manifest['graph']['sha256']:
            raise RuntimeError('Existing graph inventory changed')
        for item in inventory:
            if not re.fullmatch(r'(tiles/[0-9/]+\.gph|admins\.sqlite|tiles\.tar)',item['path']):
                raise RuntimeError('Existing graph inventory has an invalid path')
            path=target/item['path']
            if path.stat().st_size!=item['bytes'] or digest(path)!=item['sha256']:
                raise RuntimeError('Existing graph bytes changed')
    active=DATA/'active'
    temporary=DATA/('active-'+str(os.getpid()))
    temporary.symlink_to(target.relative_to(DATA),target_is_directory=True)
    temporary.replace(active)
    print('Prepared manifest:',target/'manifest.json',flush=True)
    if args.start:
        # Docker Compose is optional. Exact dedicated service equivalent for minimal hosts.
        network='urban-planning-routing-loopback'
        check=subprocess.run(['docker','network','inspect',network],capture_output=True,text=True,timeout=15)
        if check.returncode==0:
            if json.loads(check.stdout)[0].get('Labels',{}).get('urban-planning.routing')!='runtime':
                raise RuntimeError('Routing network name is already in use by an unrelated network')
        else:
            subprocess.run(['docker','network','create','--label','urban-planning.routing=runtime',network],check=True,capture_output=True,timeout=15)
        existing=subprocess.run(['docker','inspect','-f','{{index .Config.Labels "urban-planning.routing"}}','urban-planning-routing'],capture_output=True,text=True)
        if existing.returncode==0:
            if existing.stdout.strip()!='runtime':
                raise RuntimeError('A container with the routing name exists but is not owned by this tool')
            subprocess.run(['docker','rm','urban-planning-routing'],check=True,timeout=15)
        subprocess.run(['docker','run','-d','--name','urban-planning-routing','--label','urban-planning.routing=runtime',
          '--network',network,'-p','127.0.0.1:8002:8002','--read-only','--tmpfs','/tmp:size=64m,mode=1777',
          '--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','2g','--memory-swap','2g','--pids-limit','128',
          '--log-opt','max-size=5m','--log-opt','max-file=2','-v',f'{target}:/data:ro',IMAGE,'valhalla_service','/data/valhalla.json','1'],check=True,timeout=60)

if __name__=='__main__':
    main()
