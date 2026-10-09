"""Bounded counterexamples to the NON-APPLYING design checker."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

from check_proposal import check, load

HERE = pathlib.Path(__file__).resolve().parent


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.proposal = load(HERE / 'INGRESS_PROPOSAL.json')

    def test_complete_design_never_means_activation_ready(self):
        result = check(self.proposal)
        self.assertTrue(result['design_complete'], result)
        self.assertFalse(result['activation_ready'])
        self.assertFalse(result['operational_proof'])

    def test_real_cli_rejects_deliberate_counterexamples(self):
        cases = {}
        for label, change in [
            ('left-behind-internal-bypass', lambda p: p['routes'][8].update(disposition='accept-direct')),
            ('missing-route-state', lambda p: p['routes'].pop()),
            ('append-instead-of-replace', lambda p: p['header_writer'].update(operation='append')),
            ('ambiguous-identity', lambda p: p['identity_contract'].update(single_value=False)),
            ('claimed-activation', lambda p: p.update(activation_ready=True)),
            ('invented-operational-proof', lambda p: p['routes'][0].update(operational_proof='passed')),
            ('url-map-overrides-writer', lambda p: p['header_writer'].update(url_map_same_name_actions=['constant'])),
            ('default-url-left-open', lambda p: p['resources'][6]['settings'].update(future_default_uri_disabled=False)),
            ('tag-target', lambda p: p['resources'][5]['settings'].update(cloudRun_tag='stale')),
            ('attacker-header-fallback', lambda p: p['identity_contract'].update(attacker_header_fallback=True)),
            ('early-shutdown', lambda p: p['migration_constraints'].update(legacy_shutdown_before_fleet_proof=True)),
            ('unqualified-iap-claim', lambda p: p['authenticated_origin_alternative'].update(status='qualified')),
            ('undeclared-manifest-field', lambda p: p.update(apply=True)),
        ]:
            p = copy.deepcopy(self.proposal)
            change(p)
            cases[label] = json.dumps(p)
        cases['duplicate-json-field'] = '{"schema_version":1,"schema_version":1}'
        cases['truncated-json'] = '{'
        cases['missing-manifest'] = '{}'
        # Owned tiny JSON fixtures only; no provider calls or environment files.
        with tempfile.TemporaryDirectory(prefix='ingress-proposal-json-') as tmp:
            owned = pathlib.Path(tmp).resolve()
            self.assertEqual(owned.parent, pathlib.Path(tempfile.gettempdir()).resolve())
            self.assertTrue(owned.name.startswith('ingress-proposal-json-'))
            for name, body in cases.items():
                with self.subTest(name=name):
                    path = pathlib.Path(tmp) / (name + '.json')
                    path.write_text(body, encoding='utf-8')
                    result = subprocess.run([sys.executable, '-B', str(HERE / 'check_proposal.py'), str(path)], capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    parsed = json.loads(result.stdout)
                    self.assertFalse(parsed['design_complete'])
                    self.assertFalse(parsed['activation_ready'])
                    self.assertTrue(parsed['errors'])
                    print('NEGATIVE ' + name + ' rejected; activation_ready=false')


if __name__ == '__main__':
    unittest.main(verbosity=2)
