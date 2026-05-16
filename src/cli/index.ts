#!/usr/bin/env bun
import { parseArgs } from 'util';

import { ingest } from '../ingest/engine';
import { parseStoreInput, queryInputSchema, exploreInputSchema } from '../ingest/validate';
import { logger } from '../observability/logger';
import { processFeedback, RateLimitError } from '../score/feedback';
import { search, explore } from '../search/search';

const HELP = `
knoldr — AI-native universal data platform

Usage:
  knoldr store   --raw <text> | --file <path> | --input <json-path> [--source-url <url> --source-type <type>] [--json]
  knoldr query   <query> [--domain <d>] [--tags <t>] [--language <l>] [--min-authority <n>] [--limit <n>] [--json]
  knoldr explore [--domain <d>] [--tags <t>] [--min-authority <n>] [--sort authority|created_at] [--limit <n>] [--json]
  knoldr feedback <entryId> <positive|negative> [--reason <text>] [--agent-id <id>]
  knoldr audit   [--domain <d>] [--json]
  knoldr serve   [--port <n>] [--host <h>]
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case 'store':
      await handleStore(commandArgs);
      break;
    case 'query':
      await handleQuery(commandArgs);
      break;
    case 'explore':
      await handleExplore(commandArgs);
      break;
    case 'feedback':
      await handleFeedback(commandArgs);
      break;
    case 'audit':
      await handleAudit(commandArgs);
      break;
    case 'serve':
      await handleServe(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function handleServe(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.port) {
    process.env.KNOLDR_PORT = values.port;
  }
  if (values.host) {
    process.env.KNOLDR_HOST = values.host;
  }

  const { startServer } = await import('../a2a/server');
  startServer();

  // Keep process alive — server runs indefinitely
  await new Promise(() => {});
}

async function handleStore(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      raw: { type: 'string' },
      file: { type: 'string' },
      input: { type: 'string' }, // structured JSON file (Mode 2)
      'source-url': { type: 'string', multiple: true },
      'source-type': { type: 'string', multiple: true },
      json: { type: 'boolean', default: false }, // output format
    },
    allowPositionals: false,
  });

  const sourceUrls = values['source-url'] ?? [];
  const sourceTypes = values['source-type'] ?? [];
  const sources = sourceUrls.map((url, i) => ({
    url,
    sourceType: sourceTypes[i] ?? 'unknown',
  }));

  let storeInput: unknown;

  if (values.raw) {
    storeInput = { raw: values.raw, sources: sources.length > 0 ? sources : undefined };
  } else if (values.file) {
    const filePath = values.file;
    const content = filePath === '-' ? await readStdin() : await readFile(filePath);
    storeInput = { raw: content, sources: sources.length > 0 ? sources : undefined };
  } else if (values.input) {
    const jsonContent = await readFile(values.input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonContent);
    } catch {
      console.error(`Invalid JSON in file: ${values.input}`);
      process.exit(1);
    }
    storeInput = {
      ...(parsed as Record<string, unknown>),
      sources: sources.length > 0 ? sources : (parsed as Record<string, unknown>).sources,
    };
  } else {
    console.error('store requires --raw, --file, or --input');
    process.exit(1);
  }

  const validated = parseStoreInput(storeInput);
  const results = await ingest(validated);

  if (values.json) {
    console.log(JSON.stringify({ entries: results }, null, 2));
  } else {
    for (const r of results) {
      const icon = r.action === 'stored' ? '+' : r.action === 'duplicate' ? '=' : 'x';
      const idPart = r.entryId ?? `(no id — ${r.reason ?? 'rejected'})`;
      console.log(`[${icon}] ${idPart}  authority=${r.authority.toFixed(2)}  decay=${r.decayRate}  action=${r.action}`);
    }
  }
}

async function handleQuery(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      domain: { type: 'string' },
      tags: { type: 'string', multiple: true },
      language: { type: 'string' },
      'min-authority': { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const query = positionals.join(' ');
  if (!query) {
    console.error('query requires a search term');
    process.exit(1);
  }

  const input = queryInputSchema.parse({
    query,
    domain: values.domain,
    tags: values.tags,
    language: values.language,
    minAuthority: values['min-authority'] ? Number(values['min-authority']) : undefined,
    limit: values.limit ? Number(values.limit) : 10,
    cursor: values.cursor,
  });

  const result = await search(input);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.entries.length === 0) {
      console.log('No results found.');
      return;
    }
    for (let i = 0; i < result.entries.length; i++) {
      const e = result.entries[i]!;
      const s = result.scores[i]!;
      const t = result.trustLevels[i]!;
      console.log(`\n--- [${i + 1}] ${e.title} ---`);
      console.log(`  id: ${e.id}`);
      console.log(
        `  trust: ${t}  final: ${s.final.toFixed(3)}  rel: ${s.relevance.toFixed(3)}  auth: ${s.authority.toFixed(2)}  fresh: ${s.freshness.toFixed(3)}`,
      );
      console.log(`  ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`);
    }
    if (result.nextCursor) {
      console.log(`\n  --cursor ${result.nextCursor}`);
    }
  }
}

async function handleExplore(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      domain: { type: 'string' },
      tags: { type: 'string', multiple: true },
      'min-authority': { type: 'string' },
      sort: { type: 'string', default: 'authority' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const input = exploreInputSchema.parse({
    domain: values.domain,
    tags: values.tags,
    minAuthority: values['min-authority'] ? Number(values['min-authority']) : undefined,
    sortBy: values.sort,
    limit: values.limit ? Number(values.limit) : 10,
    cursor: values.cursor,
  });

  const result = await explore(input);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.entries.length === 0) {
      console.log('No entries found.');
      return;
    }
    for (let i = 0; i < result.entries.length; i++) {
      const e = result.entries[i]!;
      const s = result.scores[i]!;
      const t = result.trustLevels[i]!;
      console.log(`\n--- [${i + 1}] ${e.title} ---`);
      console.log(`  id: ${e.id}`);
      console.log(
        `  trust: ${t}  final: ${s.final.toFixed(3)}  auth: ${s.authority.toFixed(2)}  fresh: ${s.freshness.toFixed(3)}`,
      );
      console.log(`  ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`);
    }
    if (result.nextCursor) {
      console.log(`\n  --cursor ${result.nextCursor}`);
    }
  }
}

async function handleFeedback(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      reason: { type: 'string' },
      'agent-id': { type: 'string', default: 'cli' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const entryId = positionals[0];
  const signal = positionals[1] as 'positive' | 'negative';

  if (!entryId || !signal || !['positive', 'negative'].includes(signal)) {
    console.error('feedback requires: <entryId> <positive|negative>');
    process.exit(1);
  }

  try {
    const result = await processFeedback(entryId, signal, values.reason, values['agent-id']!);

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`feedback applied: ${entryId} → authority=${result.newAuthority.toFixed(3)}`);
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`rate limited: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function handleAudit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      domain: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  // Import db lazily to avoid connection on --help
  const { getDb } = await import('../db/connection');
  const { entry, entryDomain, ingestLog } = await import('../db/schema');
  const { count, eq, and, gt, sql } = await import('drizzle-orm');

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const totalEntries = await getDb().select({ cnt: count() }).from(entry);
  const activeEntries = await getDb().select({ cnt: count() }).from(entry).where(eq(entry.status, 'active'));

  const avgAuthority = await getDb()
    .select({ avg: sql<number>`COALESCE(AVG(${entry.authority}), 0)` })
    .from(entry)
    .where(eq(entry.status, 'active'));

  // Ingestion stats (last 24h)
  const stored = await getDb()
    .select({ cnt: count() })
    .from(ingestLog)
    .where(and(eq(ingestLog.action, 'stored'), gt(ingestLog.ingestedAt, oneDayAgo)));
  const duplicate = await getDb()
    .select({ cnt: count() })
    .from(ingestLog)
    .where(and(eq(ingestLog.action, 'duplicate'), gt(ingestLog.ingestedAt, oneDayAgo)));
  const rejected = await getDb()
    .select({ cnt: count() })
    .from(ingestLog)
    .where(and(eq(ingestLog.action, 'rejected'), gt(ingestLog.ingestedAt, oneDayAgo)));

  // Domain distribution
  const domainDist = await getDb()
    .select({
      domain: entryDomain.domain,
      cnt: count(),
    })
    .from(entryDomain)
    .groupBy(entryDomain.domain)
    .orderBy(sql`count(*) DESC`)
    .limit(20);

  const result = {
    totalEntries: totalEntries[0]?.cnt ?? 0,
    activeEntries: activeEntries[0]?.cnt ?? 0,
    avgAuthority: Number((avgAuthority[0]?.avg ?? 0).toFixed(3)),
    ingestion: {
      last24h: {
        stored: stored[0]?.cnt ?? 0,
        duplicate: duplicate[0]?.cnt ?? 0,
        rejected: rejected[0]?.cnt ?? 0,
      },
    },
    domainDistribution: Object.fromEntries(domainDist.map(d => [d.domain, d.cnt])),
  };

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Entries: ${result.totalEntries} total, ${result.activeEntries} active`);
    console.log(`Avg Authority: ${result.avgAuthority}`);
    console.log(
      `Last 24h: ${result.ingestion.last24h.stored} stored, ${result.ingestion.last24h.duplicate} duplicate, ${result.ingestion.last24h.rejected} rejected`,
    );
    console.log('Domains:');
    for (const [domain, cnt] of Object.entries(result.domainDistribution)) {
      console.log(`  ${domain}: ${cnt}`);
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = (Bun.stdin.stream() as ReadableStream<Uint8Array>).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  return file.text();
}

try {
  await main();
  process.exit(0);
} catch (err) {
  logger.error(err, 'CLI error');
  console.error((err as Error).message);
  process.exit(1);
}
