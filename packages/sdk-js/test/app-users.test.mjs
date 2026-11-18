import test from 'node:test';
import assert from 'node:assert/strict';
import { PeridotUsage } from '../dist/esm/usage-client.js';

test('app user directory encodes app/search, includes page and preserves response', async () => {
  const data = { users: [], total: 0, page: 2, pageSize: 25 };
  let path;
  const usage = new PeridotUsage({ get: async value => { path = value; return { ok: true, data }; } });
  assert.equal(await usage.users('app/1', { q: 'andi@pid&x=1', page: 2 }), data);
  assert.equal(path, '/v1/apps/app%2F1/users?q=andi%40pid%26x%3D1&page=2');
});
test('directory preserves API errors instead of showing an empty success', async () => {
  const error = { statusCode: 404, message: 'App not found' };
  const usage = new PeridotUsage({ get: async () => ({ ok: false, data: error }) });
  assert.equal(await usage.users('app'), error);
});
