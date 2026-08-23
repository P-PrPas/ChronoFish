#!/usr/bin/env python3
"""Run the repository's dependency-light OpenAPI contract checks."""

from pathlib import Path
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "api/openapi.yaml"


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def construct_unique_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_unique_mapping,
)


def walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def resolve_pointer(document, pointer: str):
    value = document
    for part in pointer.removeprefix("#/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        value = value[part]
    return value


def main() -> int:
    try:
        document = yaml.load(SPEC.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except yaml.YAMLError as error:
        print(error, file=sys.stderr)
        return 1
    errors: list[str] = []

    if document.get("openapi") != "3.1.0":
        errors.append("api/openapi.yaml must remain OpenAPI 3.1.0")

    operation_ids: set[str] = set()
    mutation_methods = {"post", "put", "patch", "delete"}
    required_write_headers = {
        "#/components/parameters/OperatorId",
        "#/components/parameters/DeviceId",
        "#/components/parameters/IdempotencyKey",
    }
    for path, path_item in document.get("paths", {}).items():
        for method, operation in path_item.items():
            if method not in mutation_methods or not isinstance(operation, dict):
                continue
            references = {parameter.get("$ref") for parameter in operation.get("parameters", []) if isinstance(parameter, dict)}
            for required_header in required_write_headers - references:
                errors.append(f"{method.upper()} {path} is missing {required_header}")

    for node in walk(document):
        reference = node.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/"):
            try:
                resolve_pointer(document, reference)
            except (KeyError, TypeError):
                errors.append(f"unresolved reference: {reference}")

        operation_id = node.get("operationId")
        if isinstance(operation_id, str):
            if operation_id in operation_ids:
                errors.append(f"duplicate operationId: {operation_id}")
            operation_ids.add(operation_id)

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1

    print(f"OpenAPI checks passed: {len(document['paths'])} paths, {len(operation_ids)} operations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
