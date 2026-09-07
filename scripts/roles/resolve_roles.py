#!/usr/bin/env python3
"""Read native Codex agent preferences without applying their instruction layers.

Requires Python 3.11+. Standalone, standard library only. TaskChef packages an
identical copy; neither installation imports the other at runtime.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tomllib

ROLES = ('planner', 'implementer', 'reviewer')
EFFORTS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')


def read_layer(directory):
    found = {}
    problems = []
    try:
        with os.scandir(directory) as entries:
            files = sorted(Path(entry.path) for entry in entries if entry.name.endswith('.toml'))
        for file in files:
            try:
                if file.stat().st_size > 65536:
                    raise ValueError('profile exceeds 64 KiB')
                with file.open('rb') as stream:
                    data = tomllib.load(stream)
                name = data.get('name')
                if name not in ROLES:
                    if file.stem in ROLES:
                        raise ValueError('name must match the role filename')
                    continue
                errors = []
                for field in ('description', 'developer_instructions'):
                    if not isinstance(data.get(field), str) or not data[field].strip():
                        errors.append(f'{field} must be a nonempty string')
                model = data.get('model')
                effort = data.get('model_reasoning_effort')
                entry = {'source': str(file), 'model': model, 'effort': effort, 'problems': errors}
                if name in found:
                    entry['problems'].append('duplicate role name in the same directory')
                found[name] = entry
            except (OSError, ValueError) as error:
                # Do not expose TOML lines, which can contain unrelated private data.
                message = f'{file}: unreadable or malformed agent TOML ({type(error).__name__})'
                problems.append(message)
                if file.stem in ROLES:
                    found[file.stem] = {'source': str(file), 'model': None, 'effort': None, 'problems': [message]}
    except FileNotFoundError:
        return found, problems
    except OSError:
        message = f'{directory}: cannot read agent directory'
        problems.append(message)
        found = {role: {'source': str(directory), 'model': None, 'effort': None, 'problems': [message]} for role in ROLES}
    return found, problems


def resolve(project=None, codex_home=None, explicit_model=None, explicit_effort=None):
    home = Path(codex_home or os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()
    personal, problems = read_layer(home / 'agents')
    local, local_problems = read_layer(Path(project).resolve() / '.codex' / 'agents') if project else ({}, [])
    problems += local_problems
    catalog = None
    catalog_source = str(home / 'models_cache.json')
    try:
        cache = json.loads(Path(catalog_source).read_text())
        if not isinstance(cache, dict) or not isinstance(cache.get('models'), list):
            raise ValueError('invalid catalog')
        for model in cache['models']:
            if not isinstance(model, dict) or not isinstance(model.get('slug'), str):
                raise ValueError('invalid model entry')
            levels = model.get('supported_reasoning_levels')
            if not isinstance(levels, list) or any(not isinstance(level, dict) or not isinstance(level.get('effort'), str) for level in levels):
                raise ValueError('invalid effort catalog')
        catalog = {model['slug']: model for model in cache['models']}
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, TypeError):
        problems.append('Local Codex model catalog is unreadable or malformed; validate availability with the current native tool.')
    results = []
    for role in ROLES:
        entry = local.get(role, personal.get(role))
        source = entry['source'] if entry else None
        model = entry['model'] if entry else None
        effort = entry['effort'] if entry else None
        errors = list(entry['problems']) if entry else []
        if explicit_model is not None:
            model, effort = explicit_model, explicit_effort
            effective_source = 'explicit user model choice'
            errors = []
        else:
            effective_source = source
            if explicit_effort is not None:
                effort = explicit_effort
        if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 256):
            errors.append('model must be a nonempty string of at most 256 characters')
        if effort is not None and effort not in EFFORTS:
            errors.append('reasoning effort is unsupported')
        status = 'invalid' if errors else 'configured' if (model is not None or effort is not None) else 'missing'
        availability = 'not checked; native tool must validate before dispatch'
        if model and not errors and catalog is not None:
            if model not in catalog:
                errors.append('model absent from local Codex catalog; confirm against the current native tool before dispatch')
                status = 'unavailable'
            else:
                supported = [v.get('effort') for v in catalog[model].get('supported_reasoning_levels', []) if isinstance(v, dict)]
                if effort and effort not in supported:
                    errors.append('effort absent from local model catalog; confirm against the current native tool')
                    status = 'unavailable'
                availability = 'present in cached catalog; current native tool is authoritative'
        overrides = {}
        if status == 'configured':
            if model is not None:
                overrides['model'] = model
            if effort is not None:
                overrides['thinking'] = effort
        results.append({'role': role, 'source': source, 'effectiveSource': effective_source,
                        'model': model, 'effort': effort, 'status': status,
                        'availability': availability, 'problems': errors,
                        'taskOverrides': overrides,
                        'subagentOverrides': {('reasoning_effort' if k == 'thinking' else k): v for k, v in overrides.items()},
                        'fallback': 'inherit parent settings' if role == 'reviewer' else 'native new-task default (not guaranteed dispatcher inheritance)'})
    model_options = [] if catalog is None else [
        {'value': slug, 'label': entry.get('display_name') or slug,
         'efforts': [level['effort'] for level in entry['supported_reasoning_levels']]}
        for slug, entry in catalog.items() if entry.get('visibility') != 'hide'
    ]
    return {'roles': results, 'problems': problems, 'catalogSource': catalog_source if catalog is not None else None,
            'modelOptions': model_options,
            'precedence': 'explicit user model (and its explicit effort) > project role > personal role > native defaults; explicit effort alone overrides role effort',
            'scope': 'Model and effort only; agent instructions, tools, permissions, and other TOML keys are not applied by this adapter.'}


def setup(role, model, effort, codex_home=None):
    home = Path(codex_home or os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()
    existing, problems = read_layer(home / 'agents')
    if role in existing or problems:
        return {'created': False, 'role': role, 'problems': problems or ['existing role preserved'], 'source': existing.get(role, {}).get('source')}
    if not model.strip() or len(model) > 256 or effort not in EFFORTS:
        raise ValueError('invalid model or effort')
    directory = home / 'agents'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f'{role}.toml'
    data = {'name': role, 'description': f'{role.capitalize()} model preferences',
            'developer_instructions': f'Perform the assigned {role} work within the user\'s requested scope.',
            'model': model, 'model_reasoning_effort': effort}
    try:
        with target.open('x') as stream:
            stream.write(''.join(f'{key} = {json.dumps(value)}\n' for key, value in data.items()))
    except FileExistsError:
        return {'created': False, 'role': role, 'source': str(target), 'problems': ['existing file preserved']}
    return {'created': True, 'role': role, 'source': str(target), 'model': model, 'effort': effort}


def update(role, model, effort, codex_home=None):
    home = Path(codex_home or os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()
    resolved = resolve(codex_home=str(home))
    options = {entry['value']: entry for entry in resolved['modelOptions']}
    if model not in options or effort not in options[model]['efforts']:
        raise ValueError('model or reasoning effort is unavailable')
    existing, layer_problems = read_layer(home / 'agents')
    role_entry = existing.get(role)
    if layer_problems or (role_entry and role_entry['problems']):
        raise ValueError('existing role configuration must be fixed before editing')
    if role_entry is None:
        return setup(role, model, effort, str(home))
    target = Path(role_entry['source'])
    agents = (home / 'agents').resolve()
    if target.is_symlink() or target.resolve().parent != agents:
        raise ValueError('role source is outside the personal agent directory')
    content = target.read_text()
    table = re.search(r'(?m)^\s*\[', content)
    boundary = table.start() if table else len(content)
    header, remainder = content[:boundary], content[boundary:]
    replacements = {
        'model': json.dumps(model),
        'model_reasoning_effort': json.dumps(effort),
    }
    for key, value in replacements.items():
        pattern = re.compile(rf'(?m)^(\s*{key}\s*=\s*).*$')
        if pattern.search(header):
            header = pattern.sub(rf'\g<1>{value}', header, count=1)
        else:
            prefix = '' if not header or header.endswith('\n') else '\n'
            header += f'{prefix}{key} = {value}\n'
    content = header + remainder
    temporary = target.with_name(f'.{target.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(content)
        os.chmod(temporary, target.stat().st_mode & 0o777)
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return {'updated': True, 'role': role, 'source': str(target), 'model': model, 'effort': effort}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project')
    parser.add_argument('--codex-home')
    parser.add_argument('--role', choices=ROLES)
    parser.add_argument('--model')
    parser.add_argument('--effort')
    parser.add_argument('--setup', action='store_true')
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    if args.setup and args.update:
        parser.error('--setup and --update are mutually exclusive')
    if args.setup:
        if not (args.role and args.model and args.effort):
            parser.error('--setup requires --role, --model, and --effort')
        result = setup(args.role, args.model, args.effort, args.codex_home)
    elif args.update:
        if not (args.role and args.model and args.effort):
            parser.error('--update requires --role, --model, and --effort')
        result = update(args.role, args.model, args.effort, args.codex_home)
    else:
        result = resolve(args.project, args.codex_home, args.model, args.effort)
        if args.role:
            result['roles'] = [r for r in result['roles'] if r['role'] == args.role]
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
