"""Exact coordinate-domain boundary-graph comparison. No distance/area tolerance.

This is a new diagnostic certificate, not a modification to the retained audit.
Only differing vertices can be substituted, and only through one original
source/study segment pair with the exact correctly rounded domain intersection.

Caller precondition: independently establish that Python's numeric formatting
reproduces the canonical JavaScript source/study records (including their retained
hashes). The v2 auditor checks this for all source records and the study area. A
standalone geometry comparison without those byte/hash checks is diagnostic only.
"""
from fractions import Fraction as F
import json,math,hashlib,time,sys
from pathlib import Path

def polygons(g):return [g['coordinates']] if g['type']=='Polygon' else g['coordinates']
def vertices(g):return {tuple(p) for polygon in polygons(g) for ring in polygon for p in ring}
def sub(a,b):return a[0]-b[0],a[1]-b[1]
def cross(a,b):return a[0]*b[1]-a[1]*b[0]
def point(p,domain):return tuple(F(str(x)) if domain=='decimal' else F.from_float(float(x)) for x in p)
def segments(g,role):
 return [{'id':f'{role}/{pi}/{ri}/{i}','role':role,'a':tuple(a),'b':tuple(b),'bbox':(min(a[0],b[0]),min(a[1],b[1]),max(a[0],b[0]),max(a[1],b[1]))} for pi,poly in enumerate(polygons(g)) for ri,ring in enumerate(poly) for i,(a,b) in enumerate(zip(ring,ring[1:])) if a!=b]
def overlap(a,b):return a[0]<=b[2] and b[0]<=a[2] and a[1]<=b[3] and b[1]<=a[3]
def intersection(a,b,domain):
 p,q=point(a['a'],domain),point(b['a'],domain);r,s=sub(point(a['b'],domain),p),sub(point(b['b'],domain),q);d=cross(r,s)
 if not d:return None
 t=cross(sub(q,p),s)/d;u=cross(sub(q,p),r)/d
 if not 0<t<1 or not 0<u<1:return None # endpoints remain exact original vertices
 return (p[0]+t*r[0],p[1]+t*r[1])
def on_segment(p,segment,domain):
 a,b=point(segment['a'],domain),point(segment['b'],domain)
 return cross(sub(b,a),sub(p,a))==0 and all(min(a[k],b[k])<=p[k]<=max(a[k],b[k]) for k in range(2))
def rounded(p):return tuple(float(v) for v in p)
def cycle(tokens):
 if not tokens:return ()
 options=[]
 for sequence in [tokens,list(reversed(tokens))]:
  minimum=min(sequence)
  options.extend(tuple(sequence[i:]+sequence[:i]) for i,t in enumerate(sequence) if t==minimum)
 return min(options)
def fraction(v):return {'numerator':str(v.numerator),'denominator':str(v.denominator)}

def certify(source,study,stored,native):
 errors=[];proofs=[];subdivisions=[]
 if stored is None or native is None:return {'passed':stored is None and native is None,'errors':[] if stored is None and native is None else ['one clip is missing'],'proofs':[]}
 original=vertices(source)|vertices(study);ss=segments(source,'source');ts=segments(study,'study');crossings={};by_point={'decimal':{},'binary':{}}
 # Preserve exact original vertices in the symbolic graph when one engine omits
 # a redundant subdivision. Only a point exactly on the other output edge in
 # BOTH domains may subdivide it; a genuine turn or tiny gap cannot pass.
 stored=json.loads(json.dumps(stored));native=json.loads(json.dumps(native))
 for label,target,other in [('decimal',stored,native),('binary',native,stored)]:
  for p in sorted((vertices(other)-vertices(target))&original):
   slots=[]
   for pi,poly in enumerate(polygons(target)):
    for ri,ring in enumerate(poly):
     for ei,(a,b) in enumerate(zip(ring,ring[1:])):
      segment={'a':a,'b':b}
      if list(p)!=a and list(p)!=b and all(on_segment(point(p,d),segment,d) for d in ['decimal','binary']):slots.append((pi,ri,ei,a,b))
   if len(slots)!=1:continue
   pi,ri,ei,a,b=slots[0];polygons(target)[pi][ri].insert(ei+1,list(p))
   subdivisions.append({'domain':label,'polygon':pi,'ring':ri,'point':p,'previousEdge':[a,b],'proof':'exact original vertex, collinear and strictly between endpoints in both decimal and binary64 domains','originalEndpointSegments':[s['id'] for s in ss+ts if p in [s['a'],s['b']]]})
 for a in ss:
  for b in ts:
   if not overlap(a['bbox'],b['bbox']):continue
   d=intersection(a,b,'decimal');f=intersection(a,b,'binary')
   if d is None or f is None:continue # different-domain topology cannot be certified
   key=a['id']+'|'+b['id'];crossings[key]={'source':a,'study':b,'decimal':d,'binary':f}
   for domain,value in [('decimal',d),('binary',f)]:by_point[domain].setdefault(rounded(value),set()).add(key)
 stored_points,native_points=vertices(stored),vertices(native);common=stored_points&native_points
 maps={'decimal':{},'binary':{}}
 for domain,own,other in [('decimal',stored_points,native_points),('binary',native_points,stored_points)]:
  otherdomain='binary' if domain=='decimal' else 'decimal'
  for p in own:
   if p in common:
    if p not in original:
     own_pairs=by_point[domain].get(p,set());other_pairs=by_point[otherdomain].get(p,set())
     if len(own_pairs)!=1 or own_pairs!=other_pairs:
      errors.append({'kind':'shared-nonoriginal-vertex-not-exactly-predicted','domain':domain,'point':p,'candidates':sorted(own_pairs),'otherDomainCandidates':sorted(other_pairs)})
    maps[domain][p]='C:'+json.dumps(p,separators=(',',':'));continue
   candidates=[key for key in by_point[domain].get(p,[]) if rounded(crossings[key][otherdomain]) in other and rounded(crossings[key][otherdomain]) not in common]
   # A raw vertex is never silently replaced by a nearby crossing.
   if p in original or len(candidates)!=1:
    errors.append({'kind':'unexplained-or-ambiguous-vertex','domain':domain,'point':p,'original':p in original,'candidates':sorted(candidates)});continue
   maps[domain][p]='X:'+candidates[0]
 def originals_for_neighbor(p,domain,segment):
  result=[]
  if p in original and on_segment(point(p,domain),segment,domain):result.append(point(p,domain))
  for key in by_point[domain].get(p,[]):
   c=crossings[key]
   if segment['id'] in [c['source']['id'],c['study']['id']] and on_segment(c[domain],segment,domain):result.append(c[domain])
  return set(result)
 def graph(g,domain):
  output=[]
  for pi,poly in enumerate(polygons(g)):
   rings=[]
   for ri,ring in enumerate(poly):
    coords=[tuple(p) for p in ring[:-1]]
    if ring[0]!=ring[-1]:errors.append({'kind':'unclosed-ring','domain':domain});continue
    tokens=[maps[domain].get(p,'UNPROVEN:'+json.dumps(p)) for p in coords]
    for i,token in enumerate(tokens):
     if not token.startswith('X:'):continue
     key=token[2:];c=crossings[key];p=c[domain]
     incident=[]
     for neighbor in [coords[i-1],coords[(i+1)%len(coords)]]:
      matches=[]
      for role in ['source','study']:
       qs=originals_for_neighbor(neighbor,domain,c[role]);qs.discard(p)
       if len(qs)==1:matches.append(role)
      incident.append(matches)
     if not ((incident[0]==['source'] and incident[1]==['study']) or (incident[0]==['study'] and incident[1]==['source'])):
      errors.append({'kind':'incident-boundary-not-proved','domain':domain,'point':coords[i],'neighbors':[coords[i-1],coords[(i+1)%len(coords)]],'pair':key,'incident':incident})
     proofs.append({'domain':domain,'polygon':pi,'ring':ri,'vertex':i,'pair':key,'point':coords[i],'exactIntersection':[fraction(v) for v in p],'originalSourceSegment':c['source'],'originalStudySegment':c['study'],'incident':incident})
    rings.append(cycle(tokens))
   if rings:output.append((rings[0],tuple(sorted(rings[1:]))))
  return tuple(sorted(output))
 a=graph(stored,'decimal');b=graph(native,'binary')
 if a!=b:errors.append({'kind':'boundary-graph-mismatch','storedPolygonRingLengths':[[len(r) for r in p] for p in polygons(stored)],'nativePolygonRingLengths':[[len(r) for r in p] for p in polygons(native)]})
 return {'passed':not errors,'errors':errors,'proofs':proofs,'exactOriginalVertexSubdivisions':subdivisions,'commonVertexCount':len(common),'differingStoredVertexCount':len(stored_points-common),'differingNativeVertexCount':len(native_points-common),'originalCrossingPairs':len(crossings),'boundaryGraphSha256':hashlib.sha256(json.dumps(a,separators=(',',':')).encode()).hexdigest() if a==b else None}

def main():
 start=time.monotonic();base=Path(sys.argv[1]);nativepath=Path(sys.argv[2]);output=Path(sys.argv[3]);packb=(base/'pack.json').read_bytes();pack=json.loads(packb);manifest=json.loads((base/'manifest.json').read_text());nativeb=nativepath.read_bytes();native=json.loads(nativeb)
 raw={};inputs=[]
 for receipt in manifest['receipts']:
  if receipt['role']!='before-records':continue
  path=base/'raw'/f"{receipt['sha256']}.json";blob=path.read_bytes();assert hashlib.sha256(blob).hexdigest()==receipt['sha256'];inputs.append({'path':str(path),'sha256':receipt['sha256']})
  for f in json.loads(blob)['features']:raw[(receipt['layerId'],f['properties']['OBJECTID'])]=f
 stored={f['id']:f for field in ['zones','availability','panels','revisions','seclusions'] for f in pack[field]};rows=[]
 for c in native['sourceClips']:
  key=(c['layer'],c['id']);saved=stored.get(f'{key[0]}:{key[1]}');r=certify(raw[key]['geometry'],pack['studyArea'],saved['geometry'] if saved else None,c['nativeClip']);rows.append({'layer':key[0],'id':key[1],**r})
 inputs.extend([{'path':str(base/'pack.json'),'sha256':hashlib.sha256(packb).hexdigest()},{'path':str(nativepath),'sha256':hashlib.sha256(nativeb).hexdigest()}])
 result={'version':1,'diagnosticOnly':True,'passed':all(r['passed'] for r in rows),'rows':rows,'inputs':inputs,'seconds':time.monotonic()-start,'limits':['Separate exact coordinate-domain certificate; original failed GEOS audit is preserved unchanged.','Caller must establish Python canonical-number equivalence to retained JavaScript source/study record hashes; the full v2 auditor checks those preconditions. Standalone geometry-only use remains diagnostic.','Every differing crossing vertex requires the same unique original source/study proper crossing, exact Fraction nearest-binary64 rounding in each declared domain, and proved incident source/study edges.','Original vertices omitted only as exactly collinear subdivisions are inserted into the comparison graph after proving exact on-edge/between predicates in BOTH domains; no captured coordinate or file changes.','Complete ring cycles, component count and hole-parent associations must match after symbolic substitution; there is no area/distance threshold, snapping, repair, or discarded residual.','Shared non-original coordinates require the same singleton original crossing pair in both domains, not merely coincident rounded coordinates. This certificate does not establish source mapping accuracy or assert all overlay arithmetic is exact.']}
 output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':result['passed'],'rows':len(rows),'failures':[{'layer':r['layer'],'id':r['id'],'errors':len(r['errors'])} for r in rows if not r['passed']],'seconds':result['seconds'],'output':str(output)}))
if __name__=='__main__':main()
