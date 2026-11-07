import unittest,json,math,copy,importlib.util,hashlib,time,sys
from pathlib import Path
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('certificate',ROOT/'flood-domain-certificate.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fixtures=json.loads((ROOT/'flood-domain-certificate.fixture.json').read_text())['fixtures']
TARGET=(-87.61272589261414,41.884461525975894)
BINARY=(-87.61272589261414,41.884461525975986)
def changed(g,target,replacement):
 result=copy.deepcopy(g);count=0
 for poly in module.polygons(result):
  for ring in poly:
   for i,p in enumerate(ring):
    if tuple(p)==target:ring[i]=list(replacement);count+=1
 assert count
 return result
def check(f,stored=None,native=None,source=None):return module.certify(source or f['source'],f['study'],stored or f['stored'],native or f['native'])
class DomainCertificateTests(unittest.TestCase):
 def test_actual_13_ulp_domain_difference_is_symbolically_proved(self):
  r=check(fixtures[0]);self.assertTrue(r['passed'],r['errors']);self.assertEqual((BINARY[1]-TARGET[1])/math.ulp(TARGET[1]),13)
  self.assertTrue(any(tuple(p['point'])==TARGET and p['domain']=='decimal' for p in r['proofs']))
  self.assertTrue(any(tuple(p['point'])==BINARY and p['domain']=='binary' for p in r['proofs']))
 def test_one_ulp_wrong_decimal_prediction_fails(self):
  r=check(fixtures[0],stored=changed(fixtures[0]['stored'],TARGET,(TARGET[0],math.nextafter(TARGET[1],math.inf))))
  self.assertFalse(r['passed'])
 def test_replacing_decimal_with_binary_vertex_is_not_allowed_even_when_outputs_equal(self):
  r=check(fixtures[0],stored=changed(fixtures[0]['stored'],TARGET,BINARY))
  self.assertFalse(r['passed']);self.assertTrue(any(e['kind']=='shared-nonoriginal-vertex-not-exactly-predicted' for e in r['errors']))
 def test_one_ulp_wrong_binary_prediction_fails(self):
  self.assertFalse(check(fixtures[0],native=changed(fixtures[0]['native'],BINARY,(BINARY[0],math.nextafter(BINARY[1],math.inf))))['passed'])
 def test_correct_vertices_cannot_rewire_boundary(self):
  stored=copy.deepcopy(fixtures[0]['stored']);ring=module.polygons(stored)[0][0];ring[1],ring[2]=ring[2],ring[1]
  self.assertFalse(check(fixtures[0],stored=stored)['passed'])
 def test_extra_component_or_hole_cannot_be_discarded(self):
  f=fixtures[0];poly=module.polygons(f['stored'])[0]
  extra={'type':'MultiPolygon','coordinates':[copy.deepcopy(poly),copy.deepcopy(poly)]}
  self.assertFalse(check(f,stored=extra)['passed'])
  hole=copy.deepcopy(f['stored']);module.polygons(hole)[0].append(copy.deepcopy(poly[0]))
  self.assertFalse(check(f,stored=hole)['passed'])
 def test_original_collinear_subdivision_is_preserved_with_exact_dual_domain_proof(self):
  r=check(fixtures[1]);self.assertTrue(r['passed'],r['errors']);self.assertEqual(len(r['exactOriginalVertexSubdivisions']),3)
  p=tuple(r['exactOriginalVertexSubdivisions'][0]['point']);bad=changed(fixtures[1]['native'],p,(math.nextafter(p[0],math.inf),p[1]))
  self.assertFalse(check(fixtures[1],native=bad)['passed'])
 def test_the_original_segment_pair_is_part_of_the_proof(self):
  f=fixtures[0];r=check(f);proof=next(p for p in r['proofs'] if tuple(p['point'])==TARGET);a=tuple(proof['originalSourceSegment']['a']);source=changed(f['source'],a,(math.nextafter(a[0],math.inf),a[1]))
  self.assertFalse(check(f,source=source)['passed'])
if __name__=='__main__':
 start=time.monotonic();suite=unittest.defaultTestLoader.loadTestsFromTestCase(DomainCertificateTests);result=unittest.TextTestRunner(verbosity=2).run(suite)
 proof={'passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'seconds':time.monotonic()-start,'files':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [Path(__file__),ROOT/'flood-domain-certificate.py',ROOT/'flood-domain-certificate.fixture.json']],'scope':'Exact retained-source coordinate-domain certificate regression tests; no native/source/audit acceptance mutation.'}
 if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(proof,indent=2)+'\n')
 print(json.dumps({'passed':proof['passed'],'tests':proof['tests'],'failures':proof['failures'],'errors':proof['errors']}))
 raise SystemExit(0 if result.wasSuccessful() else 1)
