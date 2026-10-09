"""Offline design-completeness checker. It cannot approve cloud activation.

No network, cloud SDK, credentials, environment loading, or applying API exists.
The JSON Schema describes the shape; this checker adds proposal-specific invariants.
"""
import json
import pathlib
import sys

ROUTES = {
    'default-numbered': 'reject', 'default-hashed': 'reject',
    'canonical-edge': 'designated-writer', 'domain-mapping': 'reject',
    'revision-tag': 'reject', 'neg-url-mask': 'reject',
    'alternate-external-lb': 'reject', 'internal-lb': 'reject',
    'internal-direct': 'reject', 'external-proxy': 'designated-writer',
    'async-platform': 'designated-writer', 'http-monitor': 'designated-writer',
    'tcp-startup': 'tcp-only',
}
ROLES = {'frontend', 'tls', 'target-proxy', 'routing', 'writer', 'origin-neg', 'origin', 'dns'}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON field: ' + key)
        result[key] = value
    return result


def load(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8'), object_pairs_hook=unique_object)


def shape_errors(value, schema, path='$'):
    """Validate the small structural subset used by the checked-in schema.

    Not a general JSON Schema engine. Only type/const/required/properties/
    additionalProperties/items are used here; metadata keywords are descriptive.
    """
    if 'const' in schema and (type(value) is not type(schema['const']) or value != schema['const']):
        return [path + ': wrong constant']
    expected = schema.get('type', [])
    expected = [expected] if isinstance(expected, str) else expected
    actual = {dict: 'object', list: 'array', str: 'string', int: 'integer', bool: 'boolean', type(None): 'null'}.get(type(value))
    if expected and actual not in expected:
        return [path + ': wrong type']
    errors = []
    if isinstance(value, dict):
        props = schema.get('properties', {})
        errors += [path + ': missing ' + k for k in schema.get('required', []) if k not in value]
        if schema.get('additionalProperties') is False:
            errors += [path + ': unknown ' + k for k in value if k not in props]
        for key in value.keys() & props.keys():
            errors += shape_errors(value[key], props[key], path + '.' + key)
    if isinstance(value, list):
        for i, item in enumerate(value):
            errors += shape_errors(item, schema.get('items', {}), path + '[' + str(i) + ']')
    return errors


def check(p):
    errors = shape_errors(p, load(pathlib.Path(__file__).with_name('INGRESS_PROPOSAL.schema.json')))
    if errors:
        return {'design_complete': False, 'activation_ready': False, 'operational_proof': False, 'errors': errors}

    def require(ok, message):
        if not ok:
            errors.append(message)

    require(p['schema_version'] == 1, 'wrong schema version')
    require(p['document_kind'] == 'non-applying-project-review-data', 'not review data')
    require(p['status'] == 'proposed-not-applied', 'cannot assert applied state')
    require(p['activation_ready'] is False and p['runtime_trust_approved'] is False, 'design checker never authorizes activation')
    require(p['proof_class'] == 'design-completeness-and-local-model-only', 'wrong proof class')
    require(p['deployed_source_equal'] is None, 'unknown source equality cannot be asserted')
    require(p['project'] == 'mandalika-pos' and p['region'] == 'asia-southeast2', 'wrong design target')
    gates = p['gates']
    require({g['id'] for g in gates} == {f'G{i:02}' for i in range(1, 8)} and len(gates) == 7, 'missing/duplicate activation prerequisite')
    require(all(g['state'] == 'unresolved' and g['fact'].strip() for g in gates), 'no operational qualification obtained')
    resources = p['resources']
    require({r['role'] for r in resources} == ROLES and len(resources) == len(ROLES), 'missing/duplicate resource role')
    by_role = {r['role']: r['settings'] for r in resources}
    require(by_role['frontend']['scheme'] == 'EXTERNAL_MANAGED' and by_role['frontend']['tier'] == 'PREMIUM', 'wrong LB class')
    require(by_role['frontend']['IPProtocol'] == 'TCP' and by_role['frontend']['port'] == 443 and by_role['frontend']['application_protocol'] == 'HTTPS', 'wrong forwarding/proxy protocol')
    require(by_role['frontend']['http_redirect'] is False and by_role['routing']['redirect_writes'] is False, 'credential/write redirect forbidden')
    require(by_role['routing']['dedicated_header_actions'] == [], 'competing URL-map writer')
    require(by_role['writer']['health_checks'] == [], 'serverless NEG has no LB health checks')
    neg = by_role['origin-neg']
    require(neg['cloudRun_service'] == 'mandalika-pos' and neg['cloudRun_tag'] is None and neg['cloudRun_urlMask'] is None, 'ambiguous NEG target')
    origin = by_role['origin']
    require(origin['future_ingress'] == 'internal-and-cloud-load-balancing' and origin['future_default_uri_disabled'] is True and origin['domain_mappings'] == [], 'network closure incomplete')
    writer = p['header_writer']
    require(writer['feature'] == 'backendService.customRequestHeaders' and writer['resource_role'] == 'writer', 'writer location changed')
    require(writer['name'] == 'X-Mandalika-Client-IP' and writer['value'] == '{client_ip_address}', 'unreviewed header semantics')
    require(writer['operation'] == 'replace-case-insensitive-all-values', 'append/non-unconditional writer')
    require(writer['url_map_same_name_actions'] == [] and writer['other_writers'] == [], 'competing header writer')
    routes = p['routes']
    require({r['id'] for r in routes} == set(ROUTES) and len(routes) == len(ROUTES), 'missing/duplicate route state')
    for route in routes:
        require(route['disposition'] == ROUTES.get(route['id']), 'unclosed/unknown route: ' + route['id'])
        require(route['gate'] in {g['id'] for g in gates}, 'route has no activation gate')
        require(route['operational_proof'] == 'pending', 'model cannot prove live route')
        require(all(route[k].strip() for k in ('current_evidence', 'mechanism', 'future_proof')), 'route lacks evidence/mechanism/proof')
    identity = p['identity_contract']
    require(identity['single_value'] is True and identity['max_ascii_bytes'] == 45, 'ambiguous identity contract')
    require(all(identity[k] is False for k in ('trim', 'allow_ports', 'allow_zones', 'allow_commas', 'attacker_header_fallback')), 'unsafe identity fallback/ambiguity')
    require(identity['ipv4_mapped'] == 'unmap' and identity['raw_peer'] == 'immutable separate field', 'identity/raw-peer drift')
    require(identity['missing_identity_status'] == 503 and identity['unqualified_route_status'] == 403, 'error-class drift')
    require(identity['valid_redis_error'] == 'existing fail-open', 'Redis policy changed')
    migration = p['migration_constraints']
    require(all(migration[k] is False for k in ('legacy_shutdown_before_fleet_proof', 'redirect_credentials_or_writes', 'logout_or_storage_reset', 'rewrite_queued_ids_payloads')), 'unsafe client migration')
    alternative = p['authenticated_origin_alternative']
    require(alternative['status'] == 'conditional-not-qualified' and alternative['new_shared_secret'] is False and len(alternative['blockers']) >= 4, 'alternative not qualified or cannot invent secrets')
    return {'design_complete': not errors, 'activation_ready': False, 'operational_proof': False, 'errors': errors}


def main():
    try:
        result = check(load(sys.argv[1]))
    except (KeyError, TypeError, ValueError, IndexError, AttributeError, OSError) as exc:
        result = {'design_complete': False, 'activation_ready': False, 'operational_proof': False, 'errors': [type(exc).__name__ + ': ' + str(exc)]}
    print(json.dumps(result, indent=2))
    return 0 if result['design_complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
