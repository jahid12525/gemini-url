// scripts/edu-mails.js
// EduMails API integration (https://api.edu-mails.com/api)

const BASE_URL = 'https://api.edu-mails.com/api';

/**
 * Safely parse JSON response with detailed error logging
 */
async function safeJson(res, context) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error(`[edu-mails] Non-JSON response during ${context}. HTTP status: ${res.status}`);
    console.error('[edu-mails] First 500 chars of body:', text.slice(0, 500));
    throw new Error(`EduMails API returned non-JSON (status ${res.status}) during ${context}. Endpoint may be down or changed.`);
  }
  if (!res.ok || json.status !== 'success') {
    throw new Error(`EduMails API error during ${context}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Fetch all active educational domains.
 * @returns {Promise<Array<{id:number,name:string,tld:string}>>}
 */
async function getDomains() {
  const res = await fetch(`${BASE_URL}/domains`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });
  const json = await safeJson(res, 'getDomains');
  return json.data.domains;
}

/**
 * Generate a new temporary email address.
 * @param {Object} opts
 * @param {'random'|'custom'} [opts.action='random']
 * @param {string} [opts.alias]     - required if action === 'custom'
 * @param {number} [opts.domainId]  - required if action === 'custom'
 * @returns {Promise<{uuid:string,address:string,created_at:string}>}
 */
async function generateEmail(opts = {}) {
  const action = opts.action || 'random';
  const body = { action };

  if (action === 'custom') {
    if (!opts.alias || !opts.domainId) {
      throw new Error('custom action requires alias and domainId');
    }
    body.alias = opts.alias;
    body.domain_id = opts.domainId;
  }

  const res = await fetch(`${BASE_URL}/emails/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await safeJson(res, 'generateEmail');
  return json.data.email; // { uuid, address, created_at }
}

/**
 * Fetch inbox messages for a given email UUID.
 * @param {string} uuid
 * @returns {Promise<{email:Object, messages:Array}>}
 */
async function getInbox(uuid) {
  const res = await fetch(`${BASE_URL}/emails/${uuid}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });
  const json = await safeJson(res, 'getInbox');
  return json.data; // { email, messages }
}

/**
 * Poll the inbox until at least one message arrives (or timeout).
 * @param {string} uuid
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=90000]
 * @param {number} [opts.intervalMs=3000]
 * @param {(msg:Object)=>boolean} [opts.filter] - optional predicate to match a specific message
 * @returns {Promise<Object>} the matched message
 */
async function pollForMessage(uuid, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 90000;
  const intervalMs = opts.intervalMs ?? 3000;
  const filter = opts.filter ?? (() => true);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { messages } = await getInbox(uuid);
    const match = (messages || []).find(filter);
    if (match) return match;

    console.log(`[edu-mails] No matching message yet, waiting ${intervalMs}ms... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for email to arrive (uuid: ${uuid})`);
}

module.exports = {
  getDomains,
  generateEmail,
  getInbox,
  pollForMessage
};
