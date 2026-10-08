import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const entry = `import { MailboxDO } from "./workers/durableObject/index.ts";
export { MailboxDO };
export default { async fetch(request, env) {
 const input = await request.json(); const stub = env.MAILBOX.get(env.MAILBOX.idFromName("local-support-fixture"));
 try { return Response.json({ result: await stub[input.method](...input.args) }); }
 catch(error) { return Response.json({ error: error.message }, { status: 500 }); }
} };`;
const output = await build({ stdin: { contents: entry, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
 bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], logLevel: 'silent' });
const mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2025-11-28',
 compatibilityFlags: ['nodejs_compat'], durableObjects: { MAILBOX: { className: 'MailboxDO', useSQLite: true } } });
async function call(method, ...args) {
 const response = await mf.dispatchFetch('http://localhost/local-fixture', { method: 'POST', body: JSON.stringify({ method, args }) });
 const value = await response.json(); if (!response.ok) throw Error(value.error); return value.result;
}
const email = (id, messageId) => ({ id, subject: 'Local support test', sender: 'support@reflowreader.com',
 recipient: 'customer@example.com', date: '2026-10-08T00:00:00Z', body: 'Test', thread_id: 'local-thread', message_id: messageId });
const attachment = (id, emailId) => ({ id, email_id: emailId, filename: 'test.txt', mimetype: 'text/plain', size: 4 });
try {
 await test('Actual SQLite DO persists accepted provider/RFC receipts across separate RPC requests', async () => {
   const first = await call('prepareSendReceipt', 'op1', 'fingerprint');
   await call('recordSendReceipt', 'op1', { ...first, providerId: 'provider', messageId: 'wire@example.com' });
   const restored = await call('prepareSendReceipt', 'op1', 'fingerprint');
   assert.equal(restored.providerId, 'provider'); assert.equal(restored.messageId, 'wire@example.com');
   await assert.rejects(call('prepareSendReceipt', 'op1', 'changed'), /different content/);
 });
 await test('Actual SQLite DO allows correction only after a definite rejection', async () => {
   const first = await call('prepareSendReceipt', 'rejected', 'first');
   await call('recordSendReceipt', 'rejected', { ...first, rejected: true });
   const updated = await call('prepareSendReceipt', 'rejected', 'corrected');
   assert.equal(updated.fingerprint, 'corrected'); assert.equal(updated.providerId, undefined);
 });
 await test('Sent row and attachments roll back together when attachment insertion fails', async () => {
   await assert.rejects(call('storeSentEmail', email('atomic', 'wire-atomic@example.com'),
     [attachment('duplicate', 'atomic'), attachment('duplicate', 'atomic')]), /UNIQUE/);
   assert.equal(await call('getEmail', 'atomic'), null);
   await call('storeSentEmail', email('atomic', 'wire-atomic@example.com'), [attachment('unique', 'atomic')]);
   const saved = await call('getEmail', 'atomic'); assert.equal(saved.folder_id, 'sent'); assert.equal(saved.attachments.length, 1);
 });
 await test('Repeated SENT save is idempotent and a wire reference resolves the same thread', async () => {
   await call('storeSentEmail', email('atomic', 'wire-atomic@example.com'), [attachment('different', 'atomic')]);
   assert.equal((await call('getEmail', 'atomic')).attachments.length, 1);
   assert.equal(await call('findThreadByMessageIds', ['unknown@example.com', 'wire-atomic@example.com']), 'local-thread');
 });
} finally { await mf.dispose(); }
