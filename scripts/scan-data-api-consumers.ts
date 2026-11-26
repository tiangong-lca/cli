import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_PUBLIC_RELATIONS,
  DATA_API_CONTRACT,
  DATA_API_RELATION_CONSUMERS,
  DATA_API_RPC_TARGETS,
} from '../src/lib/transport/supabase-data-api-contract.js';

type Finding = {
  file: string;
  line: number;
  code: string;
  detail: string;
};

type ScanOptions = {
  relationConsumers?: Record<string, readonly string[]>;
  rpcTargets?: Record<string, unknown>;
};

const ALLOWED_ROUTE_BUILDER = 'src/lib/transport/supabase-data-api-contract.ts';
const STANDARD_FROM_RECEIVERS = /(?:Array|Buffer|Object|Uint8Array)$/u;

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        result.push(fullPath);
      }
    }
  };
  visit(path.join(root, 'src'));
  return result.sort();
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function addFinding(
  findings: Finding[],
  file: string,
  source: string,
  offset: number,
  code: string,
  detail: string,
): void {
  findings.push({ file, line: lineNumber(source, offset), code, detail });
}

function annotationValues(source: string, label: string): string[] {
  const pattern = new RegExp(`^\\s*//\\s*${label}:\\s*(.+?)\\s*$`, 'gmu');
  return [...source.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isNonDataApiFrom(source: string, offset: number): boolean {
  const prefix = source.slice(Math.max(0, offset - 40), offset);
  return /\.storage\s*$/u.test(prefix) || STANDARD_FROM_RECEIVERS.test(prefix);
}

export function scanDataApiConsumers(
  root: string,
  options: ScanOptions = {},
): {
  schema_version: 'tiangong-lca-cli.data-api-consumer-scan.v1';
  contract: typeof DATA_API_CONTRACT.databaseContract;
  inventory: {
    core_relation_names: string[];
    rpc_names: string[];
    view_names: string[];
  };
  findings: Finding[];
  consumer_zero: boolean;
} {
  const findings: Finding[] = [];
  const relations = new Set<string>();
  const rpcs = new Set<string>();
  const actualConsumers = new Map<string, Set<string>>();
  const files = sourceFiles(root);
  const relationConsumers: Record<string, readonly string[]> =
    options.relationConsumers ?? DATA_API_RELATION_CONSUMERS;
  const rpcTargets = options.rpcTargets ?? DATA_API_RPC_TARGETS;

  const observeRelation = (name: string, file: string): void => {
    relations.add(name);
    const consumers = actualConsumers.get(name) ?? new Set<string>();
    consumers.add(file);
    actualConsumers.set(name, consumers);
  };

  for (const filePath of files) {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const source = readFileSync(filePath, 'utf8');
    const declaredRelations = annotationValues(source, 'data-api-relations');
    const dynamicRelationExpressions = new Set(
      annotationValues(source, 'data-api-dynamic-relation-expression'),
    );

    for (const name of declaredRelations) {
      if (!(CORE_PUBLIC_RELATIONS as readonly string[]).includes(name)) {
        addFinding(findings, relative, source, source.indexOf(name), 'UNMANIFESTED_RELATION', name);
      } else {
        observeRelation(name, relative);
      }
    }

    for (const match of source.matchAll(/\.from\(\s*([^\n)]+?)\s*\)/gu)) {
      if (isNonDataApiFrom(source, match.index)) continue;
      const expression = (match[1] ?? '').trim();
      const literal = expression.match(/^['"]([^'"]+)['"]$/u);
      if (literal) {
        const name = literal[1] as string;
        if (!(CORE_PUBLIC_RELATIONS as readonly string[]).includes(name)) {
          addFinding(findings, relative, source, match.index, 'UNMANIFESTED_RELATION', name);
        } else {
          observeRelation(name, relative);
        }
      } else if (!dynamicRelationExpressions.has(expression)) {
        addFinding(
          findings,
          relative,
          source,
          match.index,
          'DYNAMIC_RELATION_IDENTIFIER',
          expression,
        );
      }
    }

    for (const match of source.matchAll(/\.rpc\(\s*([^\n,)]+?)(?:\s*,|\s*\))/gu)) {
      const expression = (match[1] ?? '').trim();
      const literal = expression.match(/^['"]([^'"]+)['"]$/u);
      if (!literal) {
        addFinding(findings, relative, source, match.index, 'DYNAMIC_RPC_IDENTIFIER', expression);
        continue;
      }
      const name = literal[1] as string;
      rpcs.add(name);
      if (!Object.hasOwn(rpcTargets, name)) {
        addFinding(findings, relative, source, match.index, 'UNMANIFESTED_RPC', name);
      }
    }

    if (relative !== ALLOWED_ROUTE_BUILDER) {
      for (const match of source.matchAll(/\brpc\s*:\s*['"]([^'"]+)['"]/gu)) {
        const name = match[1] as string;
        rpcs.add(name);
        if (!Object.hasOwn(rpcTargets, name)) {
          addFinding(findings, relative, source, match.index, 'UNMANIFESTED_RPC', name);
        }
      }

      for (const pattern of [
        { regex: /\/rest\/v1\//gu, code: 'RAW_DATA_API_ROUTE' },
        { regex: /\/rest\/v1\/rpc\//gu, code: 'RAW_RPC_ROUTE' },
        { regex: /\/rpc\/\$\{/gu, code: 'DYNAMIC_RPC_IDENTIFIER' },
        { regex: /\.schema\(\s*['"]public['"]\s*\)/gu, code: 'IMPLICIT_PUBLIC_SCHEMA' },
        {
          regex: /['"](?:Accept-Profile|Content-Profile)['"]\s*:\s*['"]public['"]/gu,
          code: 'HARDCODED_PUBLIC_PROFILE',
        },
      ]) {
        for (const match of source.matchAll(pattern.regex)) {
          addFinding(findings, relative, source, match.index, pattern.code, match[0]);
        }
      }
    }
  }

  const relationNames = new Set([...Object.keys(relationConsumers), ...actualConsumers.keys()]);
  for (const relation of relationNames) {
    const expected = new Set(relationConsumers[relation] ?? []);
    const actual = actualConsumers.get(relation) ?? new Set<string>();
    for (const consumer of expected) {
      if (!actual.has(consumer)) {
        findings.push({
          file: consumer,
          line: 0,
          code: 'MANIFEST_CONSUMER_NOT_OBSERVED',
          detail: relation,
        });
      }
    }
    for (const consumer of actual) {
      if (!expected.has(consumer)) {
        findings.push({
          file: consumer,
          line: 0,
          code: 'RELATION_CONSUMER_UNDECLARED',
          detail: relation,
        });
      }
    }
  }

  return {
    schema_version: 'tiangong-lca-cli.data-api-consumer-scan.v1',
    contract: DATA_API_CONTRACT.databaseContract,
    inventory: {
      core_relation_names: [...relations].sort(),
      rpc_names: [...rpcs].sort(),
      view_names: [],
    },
    findings,
    consumer_zero: findings.length === 0,
  };
}

function main(): void {
  const root = process.cwd();
  const report = scanDataApiConsumers(root);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.consumer_zero) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
