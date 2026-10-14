"""Local artifact/coverage proofs in disposable synthetic repositories."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from dependency_capture import node_evidence, osv_capture
from dependency_inventory import node_inventory, license_inventory, sbom
from dependency_policy import HERE, ROOT, PolicyError, evaluate
from dependency_vendor import changed_components, inspect_archive, local_path, source_inputs, validate_declared, vendor_evidence
# Empty register: these tests prove unmodified policy blocks; the real register's entries
# (which must each match a live finding) are irrelevant to synthetic inputs.
NO_EXCEPTIONS = {'schema_version': 1, 'policy_id': 'DEPSEC-INITIAL-20260922', 'security': [], 'licenses': []}


class VendorCoverage(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="mandalika-vendor-proof-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "vendor/sheetjs/xlsx-0.20.3.tgz"
        self.path.parent.mkdir(parents=True)
        self.key = "xlsx@file:vendor/sheetjs/xlsx-0.20.3.tgz"
        self.manifest = {"name": "xlsx", "version": "0.20.3", "license": "Apache-2.0", "dependencies": {}, "scripts": {"install": "must-never-execute"}}
        self.members = {}
        self.publish()
        (self.root / "apps/backoffice").mkdir(parents=True)
        (self.root / "package.json").write_text('{}')
        (self.root / "apps/backoffice/package.json").write_text(json.dumps({"dependencies": {"xlsx": "file:../../vendor/sheetjs/xlsx-0.20.3.tgz"}}))

    def publish(self, license=True):
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w:gz") as archive:
            members = {"package/package.json": json.dumps(self.manifest).encode(), **({"package/LICENSE": b"Synthetic test terms"} if license else {}), **self.members}
            for name, value in members.items():
                item = tarfile.TarInfo(name)
                if isinstance(value, bytes):
                    item.size = len(value)
                    archive.addfile(item, io.BytesIO(value))
                else:
                    item.type = value
                    item.linkname = "../../escape"
                    archive.addfile(item)
        data = content.getvalue()
        self.path.write_bytes(data)
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
        self.package = {"resolution": {"integrity": integrity, "tarball": self.key.rsplit('@', 1)[1]}, "version": "0.20.3"}
        licenses = [{"path": "package/LICENSE", "bytes": 20, "sha256": hashlib.sha256(b"Synthetic test terms").hexdigest()}] if license else []
        # Actual byte count is derived independently of archive validation.
        if licenses:
            licenses[0]["bytes"] = len(b"Synthetic test terms")
        self.provenance = {"schema_version": 1, "name": "xlsx", "version": "0.20.3", "path": "vendor/sheetjs/xlsx-0.20.3.tgz", "source_url": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz", "distribution_kind": "official-vendor-tarball", "sha256": hashlib.sha256(data).hexdigest(), "integrity": integrity, "bytes": len(data), "package_manifest": self.manifest, "license_files": licenses}
        self.provenance.update(retrieved_at='2026-09-23T00:00:00Z', license=self.manifest.get('license'))
        self.save_provenance()

    def save_provenance(self):
        self.path.with_suffix('.provenance.json').write_text(json.dumps(self.provenance))

    def evidence(self):
        return vendor_evidence(self.root, self.key, self.package)

    def inventory(self, evidence=None, snapshot=None):
        raw = self.root / 'raw'
        raw.mkdir(exist_ok=True)
        evidence = evidence or self.evidence()
        lock = {"packages": {self.key: self.package}, "snapshots": {self.key: snapshot or {}}, "importers": {"apps/backoffice": {"dependencies": {"xlsx": {"specifier": "file:../../vendor/sheetjs/xlsx-0.20.3.tgz", "version": self.key.split('@', 1)[1]}}}}}
        (raw / 'lock.json').write_text(json.dumps(lock))
        (raw / 'node-package-evidence.json').write_text(json.dumps([evidence]))
        return node_inventory(raw)

    def test_preinstall_and_local_collector_never_fetch_registry(self):
        self.assertEqual(validate_declared(self.root)[0]['version'], '0.20.3')
        with patch('dependency_capture.fetch', side_effect=AssertionError('vendor fetched network')):
            self.assertEqual(node_evidence(self.key, self.package, self.root)['tarball_sha256'], self.provenance['sha256'])

    def test_missing_tarball_fails(self):
        self.path.unlink()
        with self.assertRaises(PolicyError): self.evidence()
        with self.assertRaises(PolicyError): validate_declared(self.root)

    def test_tampered_bytes_fail_before_archive_trust(self):
        self.path.write_bytes(self.path.read_bytes() + b'tamper')
        with self.assertRaisesRegex(PolicyError, 'pinned'): self.evidence()

    def test_lock_integrity_mismatch_fails(self):
        self.package['resolution']['integrity'] = 'sha512-wrong'
        with self.assertRaisesRegex(PolicyError, 'pinned'): self.evidence()

    def test_lock_tarball_mismatch_fails(self):
        self.package['resolution']['tarball'] = 'file:vendor/other.tgz'
        with self.assertRaisesRegex(PolicyError, 'locator'): self.evidence()

    def test_manifest_identity_mismatch_fails(self):
        for field, value in [('name', 'fake-xlsx'), ('version', '0.20.4')]:
            with self.subTest(field=field):
                old = self.manifest[field]
                self.manifest[field] = value
                self.publish()
                with self.assertRaisesRegex(PolicyError, 'identity'): self.evidence()
                self.manifest[field] = old

    def test_unsafe_member_paths_fail(self):
        for name in ['../escape', '/package/file', 'package/../escape', 'package/C:/escape', 'package\\escape', 'different/package.json']:
            with self.subTest(name=name):
                self.members = {name: b'synthetic'}
                self.publish()
                with self.assertRaisesRegex(PolicyError, 'Unsafe'): self.evidence()

    def test_archive_links_and_devices_fail(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE]:
            with self.subTest(kind=kind):
                self.members = {'package/link': kind}
                # A type flag is a byte too; construct the link directly.
                with tarfile.open(self.path, 'w:gz') as archive:
                    member = tarfile.TarInfo('package/link'); member.type = kind; member.linkname = '../../escape'; archive.addfile(member)
                with self.assertRaises(PolicyError): inspect_archive(self.path.read_bytes())

    def test_duplicate_manifest_and_json_fields_fail(self):
        self.members = {'package/./package.json': b'{}'}; self.publish()
        with self.assertRaisesRegex(PolicyError, 'Ambiguous'): self.evidence()
        self.members = {'package/package.json': b'{"name":"xlsx","name":"xlsx","version":"0.20.3"}'}; self.publish()
        with self.assertRaisesRegex(PolicyError, 'Duplicate'): self.evidence()

    def test_archive_size_bound(self):
        with patch('dependency_vendor.MAX_ARCHIVE', 1):
            with self.assertRaises(PolicyError): self.evidence()
        with patch('dependency_vendor.MAX_UNPACKED', 1):
            with self.assertRaises(PolicyError): self.evidence()

    def test_locator_escape_fails(self):
        for spec in ['file:../escape.tgz', 'file:/tmp/escape.tgz', 'file:C:/escape.tgz', 'file:vendor/../../escape.tgz', 'file:vendor\\escape.tgz']:
            with self.subTest(spec=spec):
                with self.assertRaises(PolicyError): local_path(self.root, spec)

    def test_unknown_distribution_rejected(self):
        self.provenance['source_url'] = 'https://example.invalid/latest.tgz'; self.save_provenance()
        with self.assertRaisesRegex(PolicyError, 'distribution'): self.evidence()

    def test_missing_license_bytes_fail(self):
        self.publish(license=False)
        with self.assertRaisesRegex(PolicyError, 'license'): self.evidence()

    def test_unknown_license_blocks_unchanged_policy(self):
        self.manifest['license'] = 'NOASSERTION'; self.publish()
        components = self.inventory()['components']
        result = evaluate([], license_inventory(components), NO_EXCEPTIONS, json.loads((HERE/'dependency-policy.json').read_text()), parser_root=ROOT)
        self.assertTrue(result['blocking'])

    def test_missing_component_or_edge_fails(self):
        self.manifest['dependencies'] = {'missing-child': '^1.0.0'}; self.publish()
        with self.assertRaisesRegex(PolicyError, 'edge missing'): self.inventory()
        with self.assertRaisesRegex(PolicyError, 'Unresolved'): self.inventory(snapshot={'dependencies': {'missing-child': '1.0.0'}})

    def test_dependency_peer_variant_graph_and_manifest_ranges(self):
        self.manifest['dependencies'] = {'child': '^1.0.0'}
        self.manifest['peerDependencies'] = {'peer': '^2.0.0'}
        self.publish()
        raw = self.root/'raw'; raw.mkdir()
        child = {'key':'child@1.2.3','name':'child','version':'1.2.3','scripts':{},'declared_license':'MIT','license_files':[]}
        peer = child | {'key':'peer@2.0.0','name':'peer','version':'2.0.0'}
        variant = self.key+'(peer@2.0.0)'
        lock = {'packages':{self.key:self.package,child['key']:{},peer['key']:{}},'snapshots':{variant:{'dependencies':{'child':'1.2.3','peer':'2.0.0'}},child['key']:{},peer['key']:{}},'importers':{'apps/backoffice':{'dependencies':{'xlsx':{'specifier':'file:../../vendor/sheetjs/xlsx-0.20.3.tgz','version':variant.split('@',1)[1]}}}}}
        (raw/'lock.json').write_text(json.dumps(lock))
        (raw/'node-package-evidence.json').write_text(json.dumps([self.evidence(),child,peer]))
        inventory=node_inventory(raw)
        self.assertEqual([x['scope'] for x in inventory['components']], ['runtime']*3)
        doc=sbom(inventory,license_inventory(inventory['components']),'a'*40,'2026-09-23T00:00:00Z',ROOT)
        self.assertEqual(next(x['dependsOn'] for x in doc['dependencies'] if x['ref']=='pkg:npm/xlsx@0.20.3'),['pkg:npm/child@1.2.3','pkg:npm/peer@2.0.0'])
        self.manifest['dependencies']['child']='^3.0.0';self.publish()
        (raw/'node-package-evidence.json').write_text(json.dumps([self.evidence(),child,peer]))
        with self.assertRaisesRegex(PolicyError,'version conflicts'):node_inventory(raw)

    def test_input_hashes_include_vendor_and_workspace_identity(self):
        self.inventory();lock=json.loads((self.root/'raw/lock.json').read_text())
        (self.root/'pnpm-lock.yaml').write_text('synthetic lock')
        (self.root/'backend').mkdir()
        for file in ['go.mod','go.sum']:(self.root/'backend'/file).write_text('synthetic')
        inputs=source_inputs(self.root,lock)
        self.assertEqual(inputs['vendor/sheetjs/xlsx-0.20.3.tgz'],self.provenance['sha256'])
        self.assertIn('vendor/sheetjs/xlsx-0.20.3.provenance.json',inputs)
        lock['importers']['apps/backoffice']['dependencies']['xlsx']['specifier']='file:../../vendor/other.tgz'
        with self.assertRaisesRegex(PolicyError,'declaration conflicts'):source_inputs(self.root,lock)

    def test_duplicate_and_missing_component_evidence_fail(self):
        self.inventory();file=self.root/'raw/node-package-evidence.json'
        for entries in [[],[self.evidence(),self.evidence()]]:
            file.write_text(json.dumps(entries))
            with self.assertRaisesRegex(PolicyError,'exact lockfile'):node_inventory(self.root/'raw')

    def test_inventory_sbom_and_advisory_identity(self):
        inventory = self.inventory(); component = inventory['components'][0]
        self.assertEqual((component['package'],component['version'],component['scope']),('xlsx','0.20.3','runtime'))
        doc = sbom(inventory, license_inventory(inventory['components']), 'a'*40, '2026-09-23T00:00:00Z', ROOT)
        row = doc['components'][0]
        self.assertEqual(row['purl'], 'pkg:npm/xlsx@0.20.3')
        self.assertEqual(row['hashes'][0]['content'], self.provenance['sha256'])
        self.assertEqual(row['externalReferences'][0]['url'], self.provenance['source_url'])
        self.assertEqual(doc['dependencies'][0]['dependsOn'], [])
        queries=[]
        def provider(url, data=None):
            if url.endswith('querybatch'):
                queries.extend(data['queries']);return {'results':[{}]}
            return {'vulnerabilities':[]}
        with patch('dependency_capture.request_json', side_effect=provider): osv_capture(inventory['components'], self.root)
        self.assertEqual(queries,[{'package':{'name':'xlsx','ecosystem':'npm'},'version':'0.20.3'}])

    def test_vendor_high_finding_and_provider_failure_block(self):
        component = self.inventory()['components'][0]
        finding = {k:component[k] for k in ['ecosystem','package','version','scope','reachability']}
        finding.update(id='TEST-HIGH', severity='high')
        result = evaluate([finding], [], NO_EXCEPTIONS, json.loads((HERE/'dependency-policy.json').read_text()), parser_root=ROOT)
        self.assertTrue(result['blocking'])
        with patch('dependency_capture.request_json', side_effect=ConnectionError('synthetic unavailable')):
            with self.assertRaises(ConnectionError): osv_capture([component], self.root)

    def test_distribution_and_same_version_digest_delta(self):
        c=self.inventory()['components'][0]
        self.assertEqual(changed_components({'xlsx@0.18.5':{}},[c]),[c])
        old={self.key:copy.deepcopy(self.package)};pins={c['provenance_path']:c['provenance_sha256']}
        self.assertEqual(changed_components(old,[c],pins),[])
        old[self.key]['resolution']['integrity']='sha512-different'
        self.assertEqual(changed_components(old,[c],pins),[c])

    def test_registry_integrity_still_verified(self):
        package={'resolution':{'integrity':'sha512-wrong'}}
        with patch('dependency_capture.request_json', return_value={'dist':{'tarball':'https://registry.npmjs.org/xlsx/-/xlsx-0.18.5.tgz'}}), patch('dependency_capture.fetch', return_value=self.path.read_bytes()):
            with self.assertRaisesRegex(PolicyError,'locked integrity'): node_evidence('xlsx@0.18.5',package,self.root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
