import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { build } from 'esbuild';

const compiled = transpileModule(await readFile(new URL('../workers/email-sender.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText;
const { sendEmail } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const bundle = await build({ entryPoints: [new URL('../workers/index.ts', import.meta.url).pathname], bundle: true,
  platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { app, receiveEmail } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const ID = '11111111-1111-4111-8111-111111111111';
const SUPPORT = 'support@reflowreader.com';
const message = { from: SUPPORT, to: 'customer@example.com', subject: '客服 reply', html: '<p>Hello</p>', text: 'Hello' };
const originalFetch = globalThis.fetch;

function fixture({ postStatus = 200, readStatus = 200, preflightStatus = 200, saveFails = 0, networkFails = 0, pendingReads = 0 } = {}) {
  const receipts = new Map(); const sent = new Map(); const requests = []; let puts = 0; let cfCalls = 0;
  const stub = {
    async prepareSendReceipt(id, fingerprint) {
      const old = receipts.get(id);
      if (old && !old.rejected && old.fingerprint !== fingerprint) throw Error('Different content');
      if (old && !old.rejected) return { ...old };
      const value = { fingerprint, startedAt: Date.now() }; receipts.set(id, value); return { ...value };
    },
    async recordSendReceipt(id, value) { receipts.set(id, { ...value }); },
    async checkSendRateLimit() { return null; },
    async storeSentEmail(email, attachments) { if (saveFails-- > 0) throw Error('Injected database failure'); sent.set(email.id, { ...email, attachments }); },
    async getEmail() { return { id: 'original-local', message_id: 'original@example.com', thread_id: 'existing-thread', raw_headers: '[]' }; },
    async markThreadRead() {},
    async findThreadByMessageIds(ids) { assert.ok(ids.includes('wire-id@resend.example')); return 'existing-thread'; },
    async createEmail(folder, email) { sent.set(email.id, email); },
  };
  const env = { RESEND_API_KEY: 'fake-key-not-a-credential', DOMAINS: 'novabay.space,reflowreader.com', EMAIL_ADDRESSES: [],
    MAILBOX: { idFromName: (name) => name, get: () => stub },
    EMAIL: { async send() { cfCalls++; return { messageId: '<cf-id@example.com>' }; } },
    BUCKET: { async head() { return {}; }, async put() { puts++; } },
    EMAIL_AGENT: { idFromName: (x) => x, get: () => ({ fetch: async () => new Response() }) },
  };
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://api.resend.com/'), 'No real network requests');
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/emails?limit=1')) return Response.json({ data: [] }, { status: preflightStatus });
    if (options.method === 'POST') {
      if (networkFails-- > 0) throw Error('Injected timeout');
      return Response.json(postStatus === 200 ? { id: 'provider-uuid' } : { error: 'rejected' }, { status: postStatus });
    }
    return Response.json({ message_id: pendingReads-- > 0 ? null : '<wire-id@resend.example>', last_event: 'queued' }, { status: readStatus });
  };
  return { env, stub, receipts, sent, requests, cfCalls: () => cfCalls,
    posts: () => requests.filter((r) => r.options.method === 'POST') };
}
async function sendRoute(env, suffix = 'emails', body = {}) {
  return app.request(`/api/v1/mailboxes/${SUPPORT}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...message, send_id: ID, ...body }) }, env, { waitUntil() { throw Error('Sending must not be deferred'); } });
}

try {
  await test('From/Reply-To, text, recipients, inline attachment and thread headers are mapped', async () => {
    const f = fixture(); const result = await sendEmail(f.env, { ...message, cc: ['cc@example.com'], bcc: 'hidden@example.com',
      attachments: [{ content: 'aGk=', filename: 'image.png', type: 'image/png', disposition: 'inline', contentId: 'img1' }],
      headers: { 'In-Reply-To': '<original@example.com>', References: '<original@example.com>' } }, ID);
    assert.equal(result.messageId, 'wire-id@resend.example');
    const payload = JSON.parse(f.posts()[0].options.body);
    assert.equal(payload.from, `ReflowPDF Support <${SUPPORT}>`); assert.equal(payload.reply_to, SUPPORT);
    assert.equal(payload.text, 'Hello'); assert.deepEqual(payload.cc, ['cc@example.com']); assert.equal(payload.bcc, 'hidden@example.com');
    assert.equal(payload.attachments[0].content_type, 'image/png'); assert.equal(payload.attachments[0].content_id, 'img1');
    assert.equal(payload.headers['In-Reply-To'], '<original@example.com>');
  });
  await test('Missing secret fails without network calls', async () => {
    const f = fixture(); delete f.env.RESEND_API_KEY;
    await assert.rejects(sendEmail(f.env, message, ID), /not configured/); assert.equal(f.requests.length, 0);
  });
  await test('Sending-only read permission failure stops before any send', async () => {
    const f = fixture({ preflightStatus: 403 }); await assert.rejects(sendEmail(f.env, message, ID), /read access/);
    assert.equal(f.posts().length, 0);
  });
  for (const status of [401, 403, 422, 429, 500]) {
    await test(`Provider ${status} never creates SENT or returns success`, async () => {
      const f = fixture({ postStatus: status }); const response = await sendRoute(f.env);
      assert.ok(response.status >= 400); assert.equal(f.sent.size, 0);
    });
  }
  await test('Known rejection permits corrected content without reusing the old payload key', async () => {
    const f = fixture({ postStatus: 422 }); await assert.rejects(sendEmail(f.env, message, ID));
    await assert.rejects(sendEmail(f.env, { ...message, subject: 'Corrected' }, ID));
    assert.notEqual(f.posts()[0].options.headers['Idempotency-Key'], f.posts()[1].options.headers['Idempotency-Key']);
  });
  await test('Network uncertainty retries the unchanged payload with the same idempotency key', async () => {
    const f = fixture({ networkFails: 1 }); await assert.rejects(sendEmail(f.env, message, ID), /uncertain/);
    await sendEmail(f.env, message, ID);
    assert.equal(f.posts()[0].options.headers['Idempotency-Key'], f.posts()[1].options.headers['Idempotency-Key']);
  });
  await test('Accepted send with unavailable RFC ID retries only readback', async () => {
    const f = fixture({ readStatus: 403 }); await assert.rejects(sendEmail(f.env, message, ID), /accepted/);
    await assert.rejects(sendEmail(f.env, message, ID), /accepted/); assert.equal(f.posts().length, 1);
  });
  await test('Queued 200/null readback is retried automatically without sending a second email', async () => {
    const f = fixture({ pendingReads: 1 }); const response = await sendRoute(f.env);
    assert.equal(response.status, 202); assert.equal(f.posts().length, 1); assert.equal(f.sent.size, 1);
    assert.equal(f.requests.filter((r) => r.url.endsWith('/emails/provider-uuid')).length, 2);
  });
  await test('Persistently null RFC ID stays recoverable and never creates a false SENT record', async () => {
    const f = fixture({ pendingReads: 5 }); const response = await sendRoute(f.env);
    assert.equal(response.status, 502); assert.equal(f.sent.size, 0); assert.equal(f.posts().length, 1);
    assert.equal(f.requests.filter((r) => r.url.endsWith('/emails/provider-uuid')).length, 5);
    const recovered = await sendRoute(f.env); assert.equal(recovered.status, 202); assert.equal(f.posts().length, 1);
  });
  await test('Receipt blocks an uncertain retry beyond the provider deduplication window', async () => {
    const f = fixture({ networkFails: 1 }); await assert.rejects(sendEmail(f.env, message, ID));
    f.receipts.get(ID).startedAt = Date.now() - 25 * 60 * 60 * 1000;
    await assert.rejects(sendEmail(f.env, message, ID), /too old/); assert.equal(f.posts().length, 1);
  });
  await test('Accepted payload cannot be edited under the same operation ID', async () => {
    const f = fixture(); await sendEmail(f.env, message, ID);
    await assert.rejects(sendEmail(f.env, { ...message, text: 'Changed' }, ID), /Different content/); assert.equal(f.posts().length, 1);
  });
  await test('Remote acceptance followed by local database failure can be recovered without resend', async () => {
    const f = fixture({ saveFails: 1 }); const failed = await sendRoute(f.env); assert.equal(failed.status, 502); assert.equal(f.sent.size, 0);
    const recovered = await sendRoute(f.env); assert.equal(recovered.status, 202); assert.equal(f.posts().length, 1);
    assert.equal(f.sent.size, 1); const saved = [...f.sent.values()][0]; assert.equal(saved.message_id, 'wire-id@resend.example');
    assert.notEqual(saved.id, ID, 'Sending an existing draft must not overwrite/delete the draft under its own ID');
  });
  await test('Web reply preserves existing thread and uses the RFC original ID', async () => {
    const f = fixture(); const response = await sendRoute(f.env, 'emails/original-local/reply'); assert.equal(response.status, 202);
    const payload = JSON.parse(f.posts()[0].options.body); assert.equal(payload.headers['In-Reply-To'], '<original@example.com>');
    assert.equal([...f.sent.values()][0].thread_id, 'existing-thread');
  });
  await test('Web forward uses the same sender and saves the canonical outbound ID', async () => {
    const f = fixture(); const response = await sendRoute(f.env, 'emails/original-local/forward'); assert.equal(response.status, 202);
    assert.equal([...f.sent.values()][0].message_id, 'wire-id@resend.example');
  });
  await test('Incoming reply maps actual RFC headers back to the stored conversation', async () => {
    const f = fixture(); const raw = `From: customer@example.com\r\nTo: ${SUPPORT}\r\nSubject: Re: Support\r\nMessage-ID: <next@example.com>\r\nIn-Reply-To: <wire-id@resend.example>\r\nReferences: <wire-id@resend.example>\r\n\r\nThanks`;
    const bytes = new TextEncoder().encode(raw);
    await receiveEmail({ raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), rawSize: bytes.length }, f.env, { waitUntil() {} });
    assert.equal([...f.sent.values()][0].thread_id, 'existing-thread');
  });
  await test('Other mailbox keeps its existing Cloudflare transport', async () => {
    const f = fixture(); const result = await sendEmail(f.env, { ...message, from: 'support@novabay.space' }, ID);
    assert.equal(result.messageId, 'cf-id@example.com'); assert.equal(f.cfCalls(), 1); assert.equal(f.requests.length, 0);
  });
} finally { globalThis.fetch = originalFetch; }
