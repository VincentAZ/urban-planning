#!/usr/bin/env python3
"""Read-only GDAL/GEOS audit. Run in pinned offline GDAL image, never imports JS.
Usage: python independent-ogr-audit-v2.py PACK_DIRECTORY METHOD_1_1_MODEL_JSON > audit.json
No geometry repair, snapping, simplification, metre or area buffer is used.
Source clipping is compared through exact original-segment/domain boundary graphs.
Method1.1 unions source masks before footprint work; no exposure tolerance is used.
The original audit and its failed outputs remain unchanged.
"""
import sys,json,hashlib,math,os,time,resource,re,importlib.util
from pathlib import Path
from fractions import Fraction
from decimal import Decimal
from urllib.parse import urlparse,parse_qs
from osgeo import ogr,gdal
ogr.UseExceptions()
CERT_PATH=Path(__file__).with_name("flood-domain-certificate.py")
spec=importlib.util.spec_from_file_location("flood_domain_certificate",CERT_PATH);cert_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cert_module)
START=time.monotonic(); checks=0; failures=[]; source_differences=[]; case_reports=[]; source_warnings=[]; domain_certificates=[]
R=6371008.8; EPS=sys.float_info.epsilon
MAX_BYTES=128*1024*1024

def check(ok,label,detail=None):
 global checks
 checks+=1
 if not ok: failures.append({'check':label,'detail':detail})
 return bool(ok)
def unique_index(rows,key,label,detail=None):
 ids=[row[key] for row in rows]
 check(len(set(ids))==len(ids),label,detail)
 return {row[key]:row for row in rows}
def read(path,cap=MAX_BYTES):
 p=Path(path)
 if not p.is_file() or p.stat().st_size>cap: raise ValueError('Input missing or oversized: '+str(p))
 b=p.read_bytes()
 if len(b)>cap: raise ValueError('Input grew above bound')
 return b,json.loads(b)
def digest(b):return hashlib.sha256(b).hexdigest()
def js_number(value):
 value=float(value)
 if not math.isfinite(value): raise ValueError('Nonfinite JSON number')
 if value==0:return '0'
 text=repr(value).lower()
 if 1e-6<=abs(value)<1e21:
  text=format(Decimal(text),'f')
  return text.rstrip('0').rstrip('.') if '.' in text else text
 if 'e' in text:
  mantissa,exponent=text.split('e');mantissa=mantissa.rstrip('0').rstrip('.') if '.' in mantissa else mantissa
  n=int(exponent);return mantissa+'e'+('+' if n>=0 else '-')+str(abs(n))
 return text
def canonical(value):
 if value is None:return 'null'
 if value is True:return 'true'
 if value is False:return 'false'
 if isinstance(value,(int,float)):return js_number(value)
 if isinstance(value,str):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
 if isinstance(value,list):return '['+','.join(canonical(x) for x in value)+']'
 if isinstance(value,dict):return '{'+','.join(canonical(k)+':'+canonical(value[k]) for k in sorted(value))+'}'
 raise ValueError('Unsupported JSON value')
def hash_json(value):return digest(canonical(value).encode('utf8'))
def geom(v):
 g=ogr.CreateGeometryFromJson(json.dumps(v,separators=(',',':'),allow_nan=False))
 if g is None:raise ValueError('OGR did not parse geometry')
 return g
def polygons(g):
 if g is None or g.IsEmpty():return []
 t=ogr.GT_Flatten(g.GetGeometryType())
 if t==ogr.wkbPolygon:return [g]
 if t in (ogr.wkbMultiPolygon,ogr.wkbGeometryCollection):
  return [p for i in range(g.GetGeometryCount()) for p in polygons(g.GetGeometryRef(i))]
 return []
def coords(g):
 return [(r.GetX(j),r.GetY(j)) for p in polygons(g) for i in range(p.GetGeometryCount()) for r in [p.GetGeometryRef(i)] for j in range(r.GetPointCount())]
def segments(g):
 return [(r.GetPoint_2D(j),r.GetPoint_2D(j+1)) for p in polygons(g) for i in range(p.GetGeometryCount()) for r in [p.GetGeometryRef(i)] for j in range(r.GetPointCount()-1)]
def areal(g):
 total=Fraction(0)
 for p in polygons(g):
  rings=[]
  for i in range(p.GetGeometryCount()):
   ring=p.GetGeometryRef(i);coords=[tuple(Fraction.from_float(ring.GetPoint_2D(j)[k]) for k in range(2)) for j in range(ring.GetPointCount())];origin=coords[0];coords=[(x-origin[0],y-origin[1]) for x,y in coords]
   rings.append(abs(sum((a[0]*b[1]-b[0]*a[1] for a,b in zip(coords,coords[1:])),Fraction(0)))/2)
  total+=rings[0]-sum(rings[1:],Fraction(0))
 return total
def polygon_json(g):
 ps=[json.loads(p.ExportToJson()) for p in polygons(g)]
 return None if not ps else ps[0] if len(ps)==1 else {'type':'MultiPolygon','coordinates':[p['coordinates'] for p in ps]}
def combine(gs):
 result=None
 for g in gs:
  if g is None or areal(g)==0:continue
  result=g.Clone() if result is None else result.Union(g)
  if result is None:raise ValueError('GEOS union failed')
 return result
def intersection(a,b):
 if a is None or b is None:return None
 result=a.Intersection(b)
 if result is None:raise ValueError('GEOS intersection failed')
 return result
def difference(a,b):
 if a is None:return None
 if b is None:return a.Clone()
 result=a.Difference(b)
 if result is None:raise ValueError('GEOS difference failed')
 return result
def spherical(g):
 """Independent Python spherical polygon integral, same declared Earth radius.
 Arithmetic bound accounts for input coordinate ulps and sum/product roundoff;
 used only for reported diagnostic areas, never positive-area status/units.
 """
 total=0.;bound=0.
 for p in polygons(g):
  vals=[]
  for ri in range(p.GetGeometryCount()):
   ring=p.GetGeometryRef(ri); ps=[ring.GetPoint_2D(j) for j in range(ring.GetPointCount())]
   if ps and ps[0]==ps[-1]:ps.pop()
   terms=[];coordinate_error=0.
   for i in range(len(ps)):
    lo,mid,hi=ps[i],ps[(i+1)%len(ps)],ps[(i+2)%len(ps)]
    delta=math.radians(hi[0]-lo[0]);sin=math.sin(math.radians(mid[1]));terms.append(delta*sin)
    coordinate_error+=math.radians(math.ulp(hi[0])+math.ulp(lo[0]))*abs(sin)+abs(delta)*math.radians(math.ulp(mid[1]))
   vals.append(abs(math.fsum(terms))*R*R/2)
   bound+=(coordinate_error+(len(terms)+8)*EPS*sum(abs(x) for x in terms))*R*R/2
  total+=vals[0]-sum(vals[1:]) if vals else 0.
 return total,bound

def cell_intersects_segment(point,segment):
 """Exact rational Liang-Barsky intersection with immediately adjacent floats."""
 lo=Fraction(0);hi=Fraction(1)
 for axis in range(2):
  p=point[axis];a,b=segment[0][axis],segment[1][axis]
  lower=Fraction.from_float(math.nextafter(p,-math.inf));upper=Fraction.from_float(math.nextafter(p,math.inf));start=Fraction.from_float(a);delta=Fraction.from_float(b)-start
  if delta==0:
   if not lower<=start<=upper:return False
  else:
   x=(lower-start)/delta;y=(upper-start)/delta
   lo=max(lo,min(x,y));hi=min(hi,max(x,y))
   if lo>hi:return False
 return True

def near_candidates(point,segs):
 x,y=point;ux=math.ulp(x);uy=math.ulp(y)
 return [s for s in segs if min(s[0][0],s[1][0])-ux<=x<=max(s[0][0],s[1][0])+ux and min(s[0][1],s[1][1])-uy<=y<=max(s[0][1],s[1][1])+uy]
def residual_evidence(g,segs):
 reports=[]
 for poly in polygons(g):
  points=coords(poly);unique=list(dict.fromkeys(points));exact_degenerate=len(set((x,y) for x,y in coords(poly)[:poly.GetGeometryRef(0).GetPointCount()]))<3
  certified=None
  if unique:
   for s in near_candidates(unique[0],segs):
    if all(cell_intersects_segment(p,s) for p in unique):certified=s;break
  reports.append({'areaSquareDegrees':abs(poly.GetArea()),'sphericalAreaSqm':spherical(poly)[0],
   'uniqueCoordinates':len(unique),'maximumLongitudeUlpDegrees':max((math.ulp(p[0]) for p in points),default=0),
   'maximumLatitudeUlpDegrees':max((math.ulp(p[1]) for p in points),default=0),
   'exactlyDegenerate':exact_degenerate,'singleSegmentAdjacentCellCertificate':certified is not None,
   'certifiedSegment':certified,'geometry':json.loads(poly.ExportToJson())})
 return reports

def classify(a):
 z=str(a.get('FLD_ZONE') or '').strip().upper();flag=str(a.get('SFHA_TF') or '').strip().upper();s=str(a.get('ZONE_SUBTY') or '').strip().upper()
 import re
 if z=='D' or any(x in s for x in ['AREA NOT INCLUDED','NOT MAPPED','UNMAPPED','UNDETERMINED']):return 'undetermined'
 if flag=='T' and re.fullmatch(r'(A|AE|AH|AO|A99|AR|AR/A|AR/AE|AR/AH|AR/AO|AR/A(?:[1-9]|[12][0-9]|30)|A(?:[1-9]|[12][0-9]|30)|V|VE|V(?:[1-9]|[12][0-9]|30))',z):return 'sfha'
 if flag=='F' and (z in ('B','C') or z=='X' and s in ['AREA OF MINIMAL FLOOD HAZARD','0.2 PCT ANNUAL CHANCE FLOOD HAZARD','AREA WITH REDUCED FLOOD RISK DUE TO LEVEE','AREA OF MODERATE FLOOD HAZARD','1 PCT DRAINAGE AREA LESS THAN 1 SQUARE MILE','1 PCT FUTURE CONDITIONS']):return 'other-mapped'
 return 'undetermined'

root=Path(sys.argv[1]);model_path=Path(sys.argv[2]);pack_raw,pack=read(root/'pack.json',8*1024*1024);manifest_raw,manifest=read(root/'manifest.json',2*1024*1024);model_raw,model=read(model_path)
check(digest(pack_raw)==manifest['packSha256'],'pack raw SHA256')
check(hash_json(pack)==manifest['datasetHash'],'independent canonical content SHA256')
check(canonical(pack).encode('utf8')==pack_raw,'exact canonical pack serialization')
check(hash_json(pack['studyArea'])==pack['studyAreaHash'],'independent exact study-area hash')
check(len(pack_raw)==manifest['packBytes'],'pack raw bytes')
check(digest(pack_raw)==manifest['datasetHash'],'canonical pack raw identity equals dataset hash')
check(model['datasetHash']==manifest['datasetHash'],'model exact captured dataset identity')
check(pack['studyArea']==manifest['studyArea'],'manifest exact study geometry')
area=geom(pack['studyArea']);check(area.IsValid(),'study topology GEOS')
points=coords(area);envelope=','.join(js_number(x) for x in [min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)])
query={'geometry':envelope,'geometryType':'esriGeometryEnvelope','inSR':'4326','spatialRel':'esriSpatialRelIntersects'}
check(hash_json(query)==pack['capture']['queryGeometryHash'],'exact source query geometry hash')
check(pack['capture']['complete'] is True,'complete source capture declared')

raw={};by_phase={}
for r in manifest['receipts']:
 parsed_url=urlparse(r['url']);params=parse_qs(parsed_url.query)
 check(parsed_url.scheme=='https' and parsed_url.netloc=='hazards.fema.gov' and parsed_url.path in [f"/arcgis/rest/services/public/NFHL/MapServer/{r['layerId']}",f"/arcgis/rest/services/public/NFHL/MapServer/{r['layerId']}/query"],'official exact source endpoint',r['role'])
 if r['role'] in ['before-ids','after-ids']:check(all(params.get(k)==[v] for k,v in query.items()) and params.get('returnIdsOnly')==['true'],'exact envelope ID query')
 if r['role'] in ['before-records','after-records']:check(params.get('f')==['geojson'] and params.get('outSR')==['4326'] and params.get('outFields')==['*'] and params.get('returnGeometry')==['true'],'complete original-field WGS84 geometry query')
 b,d=read(root/'raw'/(r['sha256']+'.json'),32*1024*1024)
 check(digest(b)==r['sha256'] and len(b)==r['bytes'],'raw response identity',{'role':r['role'],'layer':r['layerId'],'batch':r['batch']})
 check(not d.get('error') and not d.get('exceededTransferLimit'),'no source truncation/error')
 raw[r['sha256']]=d;by_phase.setdefault((r['role'],r['layerId']),[]).append((r['batch'],d,r))
for v in by_phase.values():v.sort(key=lambda t:t[0])
check(len(pack['files'])==len(manifest['receipts']),'receipt inventory count')
for f,r in zip(pack['files'],manifest['receipts']):check(all(f[k]==r[k] for k in ['url','sha256','bytes','retrievedAt']),'pack file exact receipt')
layer_names={0:'availability',1:'revisions',3:'panels',28:'zones',29:'seclusions'}
source_counts={};reconstructed_records={}
for lid,field in layer_names.items():
 before=sorted(by_phase[('before-ids',lid)][0][1].get('objectIds') or []);after=sorted(by_phase[('after-ids',lid)][0][1].get('objectIds') or [])
 check(before==after and len(set(before))==len(before),'unchanged complete IDs',lid)
 records={}
 for phase in ['before-records','after-records']:
  rows=[f for _,d,_ in by_phase.get((phase,lid),[]) for f in d['features']]
  ids=sorted(f['properties']['OBJECTID'] for f in rows)
  check(ids==before and len(set(ids))==len(ids),'batch IDs exact',{'layer':lid,'phase':phase})
  records[phase]={f['properties']['OBJECTID']:f for f in rows}
 check(records['before-records']==records['after-records'],'unchanged exact raw records',lid)
 reconstructed_records[lid]={phase:[{'id':oid,'properties':rows[oid]['properties'],'geometry':rows[oid]['geometry']} for oid in sorted(rows)] for phase,rows in records.items()}
 retained=unique_index(pack[field],'id','unique retained source feature IDs',{'layer':lid,'field':field});expected_ids=set();raw_total=len(before)
 for oid,f in records['before-records'].items():
  source=geom(f['geometry']);gdal.ErrorReset();gdal.PushErrorHandler('CPLQuietErrorHandler')
  try:raw_valid=source.IsValid();raw_reason=gdal.GetLastErrorMsg()
  finally:gdal.PopErrorHandler()
  native=intersection(source,area);key=f'{lid}:{oid}'
  if not raw_valid:
   numbers=re.findall(r'[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?',raw_reason)
   defect=None
   if len(numbers)>=2 and ('intersection' in raw_reason.lower()):
    x,y=map(float,numbers[-2:]);defect=ogr.Geometry(ogr.wkbPoint);defect.AddPoint_2D(x,y)
   outside=defect is not None and not defect.Intersects(area)
   local_valid=native is not None and (native.IsEmpty() or native.IsValid())
   check(outside and local_valid,'raw source defect is diagnosed outside exact study and local clip is valid',{'layer':lid,'id':oid,'reason':raw_reason,'defectOutsideStudy':outside,'localClipValid':local_valid})
   source_warnings.append({'layer':lid,'id':oid,'reason':raw_reason,'diagnosticPoint':json.loads(defect.ExportToJson()) if defect else None,'defectOutsideStudy':outside,'localClipValid':local_valid,'scope':'The complete raw source is not valid and remains unchanged. Acceptance is limited to the independently valid/equivalent local clipped result; no global source-validity claim or repair.'})
  else:check(True,'raw source GEOS topology',{'layer':lid,'id':oid})
  if areal(native)>0:expected_ids.add(key)
  stored=retained.get(key)
  if stored is None:
   certificate=cert_module.certify(f['geometry'],pack['studyArea'],None,polygon_json(native))
   domain_certificates.append({'layer':lid,'id':oid,**certificate})
   check(certificate['passed'],'complete source clip boundary graph',{'layer':lid,'id':oid,'errors':certificate['errors']})
   continue
  check(stored['attributes']==f['properties'],'source attributes unchanged',key)
  normalized=geom(stored['geometry']);check(normalized.IsValid(),'normalized GEOS topology',key)
  certificate=cert_module.certify(f['geometry'],pack['studyArea'],stored['geometry'],polygon_json(native))
  domain_certificates.append({'layer':lid,'id':oid,**certificate})
  check(certificate['passed'],'exact coordinate-domain source boundary graph',{'layer':lid,'id':oid,'errors':certificate['errors']})
  diff=normalized.SymDifference(native)
  if polygons(diff):
   source_differences.append({'layer':lid,'id':oid,'kind':'diagnostic-only-GEOS-symmetric-difference','residuals':residual_evidence(diff,segments(area)+segments(source))})
  if lid==28:check(stored['classification']==classify(f['properties']),'independent source zone classification',key)
 check(set(retained).issubset({f'{lid}:{oid}' for oid in before}),'no fabricated feature IDs',lid)
 source_counts[field]={'rawFeatures':raw_total,'nativePositiveClips':len(expected_ids),'retainedFeatures':len(retained)}
study_before=by_phase[('before-study',41)][0][1]['features'];study_after=by_phase[('after-study',41)][0][1]['features']
check(study_before==study_after,'Study_Info exact fence')
reconstructed_records[41]={'before-records':[{'id':f['attributes']['OBJECTID'],'properties':f['attributes']} for f in sorted(study_before,key=lambda x:x['attributes']['OBJECTID'])],'after-records':[{'id':f['attributes']['OBJECTID'],'properties':f['attributes']} for f in sorted(study_after,key=lambda x:x['attributes']['OBJECTID'])]}
check(sorted((f['attributes'] for f in study_before),key=lambda v:v['OBJECTID'])==pack['capture']['studyInfo'],'retained Study_Info attributes')
for receipt in pack['capture']['layerReceipts']:
 lid=receipt['layerId'];expected=sorted(f['attributes']['OBJECTID'] for f in study_before) if lid==41 else sorted(by_phase[('before-ids',lid)][0][1].get('objectIds') or [])
 check(receipt['objectIds']==expected,'normalized layer object-ID inventory',lid)
 check(receipt['beforeIdsHash']==hash_json(expected) and receipt['afterIdsHash']==hash_json(expected),'independent ID fence SHA256',lid)
 check(receipt['beforeRecordsHash']==hash_json(reconstructed_records[lid]['before-records']) and receipt['afterRecordsHash']==hash_json(reconstructed_records[lid]['after-records']),'independent source-record fence SHA256',lid)
 check(receipt['fileHashes']==[r['sha256'] for r in manifest['receipts'] if r['layerId']==lid],'exact per-layer raw receipt order',lid)
 check(all(h in raw for h in receipt['fileHashes']),'normalized layer raw references',lid)

zones=[(r,geom(r['geometry'])) for r in pack['zones']];available=combine([geom(r['geometry']) for r in pack['availability']]);geometry_cache={};max_area_error=0.;area_checks=0
hazard_mask=combine([g for r,g in zones if r['classification']=='sfha'])
classified_mask=combine([g for r,g in zones if r['classification']!='undetermined'])
unknown_mask=combine([g for r,g in zones if r['classification']=='undetermined'])
covered_mask=difference(intersection(classified_mask,available),unknown_mask)
for label,mask in [('hazard',hazard_mask),('classified',classified_mask),('availability',available),('unknown',unknown_mask),('covered',covered_mask)]:
 check(mask is None or mask.IsValid(),'complete native mask topology',label)

def exposure(building):
 g=building.get('geometry') or {'type':'Polygon','coordinates':[building['footprint']]};key=json.dumps(g,sort_keys=True,separators=(',',':'))
 if key in geometry_cache:return geometry_cache[key]
 footprint=geom(g)
 if not footprint.IsValid():raise ValueError('Invalid native building geometry: '+building['id'])
 hits=[];known=[];unknown=[];ids=[]
 for row,shape in zones:
  clip=intersection(footprint,shape)
  if areal(clip)==0:continue
  ids.append(row['id'])
  if row['classification']=='sfha':hits.append(clip)
  (unknown if row['classification']=='undetermined' else known).append(clip)
 hazard=intersection(footprint,hazard_mask);remainder=difference(footprint,covered_mask)
 status='intersects-sfha' if areal(hazard)>0 else 'undetermined' if areal(remainder)>0 else 'no-sfha-intersection'
 result={'status':status,'zoneIds':sorted(ids),'hazard':hazard,'remainder':remainder,'geometry':footprint}
 geometry_cache[key]=result;return result

for case in model['cases']:
 check(case['result']['methodVersion']=='flood-footprint-1.1.0' and case['scenario']['flood'].get('methodVersion')=='flood-footprint-1.1.0','explicit method1.1 reference/result',case['name'])
 sides={};before_fail=len(failures);rows_checked=0
 for side_name,input_name in [('baseline','baselineBuildings'),('scenario','scenarioBuildings')]:
  expected=case['result'][side_name];buildings=case[input_name]
  input_index=unique_index(buildings,'id','unique input building IDs',{'case':case['name'],'side':side_name})
  saved=unique_index(expected['buildings'],'buildingId','unique saved building ledger IDs',{'case':case['name'],'side':side_name});known_sum=0;resolved=0;missing=[];unclassified=[];status_counts={}
  check(set(saved)==set(input_index) and len(saved)==len(buildings),'complete unique building ledger',{'case':case['name'],'side':side_name})
  for b in buildings:
   e=exposure(b);r=saved[b['id']];units=b['units'];check(units is None or isinstance(units,int) and units>=0,'valid retained home quantity',b['id']);status=e['status'];status_counts[status]=status_counts.get(status,0)+1
   exposed=0 if units==0 or status=='no-sfha-intersection' else units if status=='intersects-sfha' else None
   check(r['status']==status,'native footprint status',{'case':case['name'],'side':side_name,'id':b['id'],'native':status,'model':r['status'],'remainderAreaSquareDegrees':float(areal(e['remainder'])),'boundaryResidue':residual_evidence(e['remainder'],segments(e['geometry'])) if status!=r['status'] else []})
   check(r['units']==units and r['exposedUnits']==exposed,'home count/null and whole-building exposure',{'case':case['name'],'side':side_name,'id':b['id']})
   check(r['zoneIds']==e['zoneIds'],'exact intersecting zone IDs',{'case':case['name'],'side':side_name,'id':b['id']})
   for field,shape in [('intersectionAreaSqm',e['hazard']),('unclassifiedAreaSqm',e['remainder'])]:
    value,bound=spherical(shape);actual=r[field];error=abs(actual-value) if actual is not None else math.inf;max_area_error=max(max_area_error,error);area_checks+=1
    check(actual is not None and error<=bound+8*math.ulp(max(abs(actual or 0),abs(value))), 'diagnostic spherical area arithmetic bound',{'case':case['name'],'side':side_name,'id':b['id'],'field':field,'nativeSqm':value,'modelSqm':actual,'absoluteErrorSqm':error,'binary64BoundSqm':bound})
   if units==0 or status=='no-sfha-intersection':resolved+=1
   else:
    if status=='undetermined':unclassified.append(b['id'])
    if units is None:missing.append(b['id'])
    if status=='intersects-sfha' and units is not None:known_sum+=units;resolved+=1
   rows_checked+=1
  result={'value':None if missing or unclassified else known_sum,'knownSubtotal':known_sum if resolved or not buildings else None,'missingUnitBuildingIds':sorted(missing),'unclassifiedBuildingIds':sorted(unclassified)}
  for k,v in result.items():check(expected[k]==v,'independent total/completeness '+k,{'case':case['name'],'side':side_name,'native':v,'model':expected[k]})
  sides[side_name]={**result,'buildings':len(buildings),'statuses':status_counts}
 delta=None if sides['baseline']['value'] is None or sides['scenario']['value'] is None else sides['scenario']['value']-sides['baseline']['value']
 check(case['result']['delta']==delta,'independent delta',case['name'])
 case_reports.append({'name':case['name'],'rowsChecked':rows_checked,'delta':delta,'sides':sides,'newFailures':len(failures)-before_fail})

result={'version':2,'passed':not failures,'checks':checks,'engine':{'gdal':gdal.VersionInfo('--version'),'geos':f'{ogr.GetGEOSVersionMajor()}.{ogr.GetGEOSVersionMinor()}.{ogr.GetGEOSVersionMicro()}'},'inputs':{'scriptSha256':digest(Path(__file__).read_bytes()),'domainCertificateSha256':digest(CERT_PATH.read_bytes()),'methodVersion':'flood-footprint-1.1.0','datasetHash':manifest['datasetHash'],'pack':{'sha256':digest(pack_raw),'bytes':len(pack_raw)},'manifest':{'sha256':digest(manifest_raw),'bytes':len(manifest_raw)},'model':{'sha256':digest(model_raw),'bytes':len(model_raw)}},'sourceCounts':source_counts,'sourceGeometryDifferences':source_differences,'sourceDomainCertificates':domain_certificates,'rawSourceWarnings':source_warnings,'cases':case_reports,'geometryCacheEntries':len(geometry_cache),'diagnosticAreaChecks':area_checks,'maximumDiagnosticAreaErrorSqm':max_area_error,'failures':failures,'resources':{'seconds':time.monotonic()-START,'maximumRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},'limits':['Any diagnosed outside-study raw self-intersection is retained as a source-quality warning; only independently valid, equivalent local clips are accepted, without claiming global source validity.','This audit checks retained bytes, native geometry and numerical bookkeeping; it does not validate FEMA mapping accuracy or building/home source completeness.','Source clipping compares complete boundary graphs modulo exact collinear original-vertex subdivisions and same-original-segment exact coordinate-domain intersections. GEOS symmetric differences remain diagnostics, not acceptance thresholds; no area/metre buffer or repair.','Method1.1 exposure uses unioned original source masks, strict native positive polygon intersection/remainder with exact binary64 shoelace positivity, and no source-domain certificate to change any footprint classification. Every disagreement fails.','Spherical diagnostic areas use the declared radius and an explicit arithmetic error bound; that bound never controls footprint status, null states or home counts.']}
print(json.dumps(result,indent=2,allow_nan=False));sys.exit(0 if result['passed'] else 1)
