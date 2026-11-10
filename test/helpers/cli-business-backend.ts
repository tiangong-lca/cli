// Controlled protocol fixture, not a replacement for Database/Edge qualification.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, DatasetType } from '../../src/application/dataset-types.js';
import type { FetchLike } from '../../src/lib/transport/http.js';
import {
  businessActor,
  businessReviewer,
  businessOutsider,
  businessIdentity,
  businessFixture,
  writableTypes,
} from './cli-business-fixtures.js';

const tables: Record<string, DatasetType> = {
  flows: 'flow',
  processes: 'process',
  lifecyclemodels: 'model',
  sources: 'source',
  contacts: 'contact',
};
const referenceTables: Record<string, string> = {
  'flow data set': 'flows',
  'process data set': 'processes',
  'source data set': 'sources',
  'contact data set': 'contacts',
  'flow property data set': 'flowproperties',
  'unit group data set': 'unitgroups',
};
type Row = {
  id: string;
  version: string;
  json: JsonObject;
  user_id: string;
  state_code: number;
  json_tg?: JsonObject;
};
export function createBusinessBackend() {
  const rows = new Map<string, Row>();
  const refs = new Map<string, { id: string; version: string }>();
  const reviews = new Map<string, JsonObject>();
  const drafts = new Set<string>();
  const decisions = new Map<string, string>();
  const calls: Array<{ path: string; method: string; body: JsonObject; actor: string }> = [];
  const loseReplies = new Set<string>();
  const rejectReplies = new Map<string, { code: string; status: number }>();
  const files = new Map<string, string>();
  const key = (table: string, id: string, version: string) => `${table}:${id}:${version}`;
  const json = (body: unknown, status = 200, count?: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        ...(count === undefined
          ? {}
          : { 'content-range': count ? `0-${count - 1}/${count}` : '*/0' }),
      },
    });
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const item = value as JsonObject;
      const table = referenceTables[String(item['@type'])];
      if (table && typeof item['@refObjectId'] === 'string' && typeof item['@version'] === 'string')
        refs.set(key(table, item['@refObjectId'], item['@version']), {
          id: item['@refObjectId'],
          version: item['@version'],
        });
      Object.values(item).forEach(walk);
    }
  };
  for (const type of writableTypes) walk(businessFixture(type));
  const seed = (table: string, content: JsonObject, owner = businessActor, state = 0) => {
    const identity = businessIdentity(tables[table]!, content);
    rows.set(key(table, identity.id, identity.version), {
      ...identity,
      json: structuredClone(content),
      user_id: owner,
      state_code: state,
    });
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const token = new Headers(init?.headers).get('authorization');
    const actor =
      token === 'Bearer reviewer-token'
        ? businessReviewer
        : token === 'Bearer outsider-token'
          ? businessOutsider
          : businessActor;
    if (url.pathname === '/auth/v1/user')
      return json({ id: actor, email: 'synthetic@example.test', role: 'authenticated' });
    if (url.pathname === '/auth/v1/health') return json({ version: 'fixture' });
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const storageKey = url.pathname.replace(
        /^\/storage\/v1\/object\/(?:authenticated\/|sign\/)?/u,
        '',
      );
      if (method === 'POST' && url.pathname.includes('/object/sign/'))
        return json({ signedURL: `/object/sign/${storageKey}?token=fixture` });
      if (method === 'POST') {
        assert.equal(new Headers(init?.headers).get('x-upsert'), 'false');
        assert.ok(!files.has(storageKey));
        files.set(storageKey, String(init?.body));
        return json({ Key: storageKey });
      }
      assert.equal(method, 'GET');
      assert.ok(files.has(storageKey));
      return new Response(files.get(storageKey), {
        headers: { 'content-type': 'application/pdf' },
      });
    }
    const body =
      init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as JsonObject) : {};
    calls.push({ path: url.pathname, method, body, actor });
    const refusal = rejectReplies.get(url.pathname.split('/').at(-1)!);
    if (refusal)
      return json(
        { ok: false, code: refusal.code, message: 'Bearer hidden-secret' },
        refusal.status,
      );
    if (url.pathname === '/rest/v1/rpc/qry_review_get_items') {
      assert.equal(new Headers(init?.headers).get('content-profile'), 'api');
      if (url.searchParams.has('reviewer_id'))
        assert.equal(url.searchParams.get('reviewer_id'), `cs.${JSON.stringify([actor])}`);
      const selected = [...reviews.values()].filter((r) => {
        if (actor !== businessActor && actor !== businessReviewer) return false;
        if (Array.isArray(body.p_review_ids) && !body.p_review_ids.includes(r.id)) return false;
        if (Array.isArray(body.p_state_codes) && !body.p_state_codes.includes(r.state_code))
          return false;
        if (url.searchParams.has('reviewer_id') && actor !== businessReviewer) return false;
        return true;
      });
      return json(selected, 200, selected.length);
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      assert.equal(method, 'GET');
      const table = url.pathname.split('/').at(-1)!;
      const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
      const version = url.searchParams.get('version')?.replace(/^eq\./u, '');
      const select = url.searchParams.get('select');
      let selected: unknown[] = [...rows.values()].filter(
        (r) =>
          rows.get(key(table, r.id, r.version)) === r &&
          (!id || r.id === id) &&
          (!version || r.version === version) &&
          (r.user_id === actor || actor === businessReviewer),
      );
      if (select === 'id,version') {
        const known = [...refs.entries()]
          .filter(
            ([k, r]) =>
              k.startsWith(`${table}:`) &&
              (!id || r.id === id) &&
              (!version || r.version === version),
          )
          .map(([, r]) => r);
        selected = known.length ? known : selected;
      }
      if (url.searchParams.get('limit') === '1') selected = selected.slice(0, 1);
      return json(selected, 200, selected.length);
    }
    if (!url.pathname.startsWith('/functions/v1/'))
      throw new Error(`Unexpected protocol route: ${url.pathname}`);
    const endpoint = url.pathname.split('/').at(-1)!;
    let response: Response;
    if (
      endpoint === 'save_lifecycle_model_bundle' ||
      ['app_dataset_create', 'app_dataset_save_draft', 'app_dataset_delete'].includes(endpoint)
    ) {
      const model = endpoint === 'save_lifecycle_model_bundle';
      const table = model ? 'lifecyclemodels' : String(body.table);
      const content = model
        ? ((body.parent as JsonObject).jsonOrdered as JsonObject)
        : (body.jsonOrdered as JsonObject);
      const id = String(model ? body.modelId : body.id);
      const version = content
        ? businessIdentity(tables[table]!, content).version
        : String(body.version);
      const rowKey = key(table, id, version),
        current = rows.get(rowKey);
      const create = model ? body.mode === 'create' : endpoint === 'app_dataset_create';
      const denied =
        actor !== businessActor ||
        (create ? !!current : !current || current.user_id !== actor || current.state_code !== 0);
      if (
        denied ||
        (!model &&
          body.expectedJsonOrdered !== undefined &&
          !isDeepStrictEqual(body.expectedJsonOrdered, current?.json))
      )
        return json({ ok: false, code: 'VERSION_CONFLICT' }, 409);
      if (model) assert.deepEqual(body.processMutations, []);
      if (endpoint === 'app_dataset_delete') rows.delete(rowKey);
      else {
        seed(table, content);
        if (model) rows.get(rowKey)!.json_tg = (body.parent as JsonObject).jsonTg as JsonObject;
      }
      response = json(
        model ? { ok: true, modelId: id, version } : { ok: true, data: { id, version } },
      );
    } else if (endpoint === 'app_dataset_submit_review') {
      const row = rows.get(key(String(body.table), String(body.id), String(body.version)));
      if (!row || row.user_id !== actor || row.state_code !== 0)
        return json({ ok: false, code: 'DATA_NOT_EDITABLE' }, 409);
      const reviewId = randomUUID();
      reviews.set(reviewId, {
        id: reviewId,
        state_code: 0,
        reviewer_id: [businessReviewer],
        json: {
          data: { table: body.table, id: body.id, version: body.version },
          user: { id: actor },
        },
      });
      row.state_code = 20;
      response = json({ ok: true, data: { reviewId, mode: 'created' } });
    } else if (
      endpoint === 'app_review_save_comment_draft' ||
      endpoint === 'app_review_batch_decision'
    ) {
      const reviewId = String(body.reviewId ?? (body.reviewIds as string[])[0]);
      const review = reviews.get(reviewId);
      if (!review || actor !== businessReviewer)
        return json({ ok: false, code: 'REVIEWER_REQUIRED' }, 403);
      if (endpoint === 'app_review_save_comment_draft') {
        drafts.add(reviewId);
        response = json({ ok: true, data: { reviewId } });
      } else {
        if (!drafts.has(reviewId))
          return json(
            { ok: false, results: [{ reviewId, ok: false, code: 'REVIEW_DRAFT_REQUIRED' }] },
            409,
          );
        decisions.set(reviewId, String(body.decision));
        response = json({ ok: true, results: [{ reviewId, ok: true }] });
      }
    } else throw new Error(`Unexpected mutation endpoint: ${endpoint}`);
    if (loseReplies.delete(endpoint)) throw new Error('Synthetic response loss after commit');
    return response;
  };
  const start = async () => {
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await fetchImpl(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
        });
        assert.ok(result.headers instanceof Headers);
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(await result.text());
      } catch {
        response.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      origin: `http://127.0.0.1:${address.port}`,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  };
  // Assignment/finalization are explicit existing admin-service phases, outside these CLI commands.
  const assign = (reviewId: string) => {
    const review = reviews.get(reviewId)!;
    assert.equal(review.state_code, 0);
    review.state_code = 1;
  };
  const finalize = (reviewId: string) => {
    const review = reviews.get(reviewId)!;
    assert.equal(review.state_code, 1);
    assert.ok(decisions.has(reviewId));
    const rejected = decisions.get(reviewId) === 'reject';
    review.state_code = rejected ? -1 : 100;
    const target = (review.json as JsonObject).data as JsonObject;
    rows.get(key(String(target.table), String(target.id), String(target.version)))!.state_code =
      rejected ? 0 : 100;
  };
  return {
    rows,
    reviews,
    calls,
    loseReplies,
    rejectReplies,
    seed,
    fetchImpl,
    start,
    assign,
    finalize,
  };
}
