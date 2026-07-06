const https = require('https');

const BASE_URL = 'https://api.edu-mails.com';

/**
 * Generates a temporary email address via EduMails API
 * @param {Object} options
 * @param {string} options.action - 'random' or 'custom'
 * @param {string} [options.username] - required if action is 'custom'
 * @param {string} [options.domain] - required if action is 'custom'
 * @returns {Promise<{address: string, uuid: string}>}
 */
function generateEmail(options = { action: 'random' }) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(options);

        const req = https.request(
            `${BASE_URL}/generate`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (!json.success) {
                            reject(new Error(json.message || 'Failed to generate email'));
                            return;
                        }
                        resolve({
                            address: json.email,
                            uuid: json.uuid,
                        });
                    } catch (err) {
                        reject(new Error(`Invalid JSON response: ${data}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Fetches messages for a given email UUID
 * @param {string} uuid
 * @returns {Promise<Array>}
 */
function getMessages(uuid) {
    return new Promise((resolve, reject) => {
        https
            .get(`${BASE_URL}/messages/${uuid}`, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (!json.success) {
                            reject(new Error(json.message || 'Failed to fetch messages'));
                            return;
                        }
                        resolve(json.messages || []);
                    } catch (err) {
                        reject(new Error(`Invalid JSON response: ${data}`));
                    }
                });
            })
            .on('error', reject);
    });
}

/**
 * Polls inbox until a message arrives or timeout
 * @param {string} uuid
 * @param {Object} options
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.intervalMs=3000]
 * @returns {Promise<Array>}
 */
async function waitForMessage(uuid, options = {}) {
    const { timeoutMs = 60000, intervalMs = 3000 } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const messages = await getMessages(uuid);
        if (messages.length > 0) {
            return messages;
        }
        console.log(`No messages yet, waiting ${intervalMs}ms...`);
        await sleep(intervalMs);
    }

    throw new Error(`Timeout: No messages received within ${timeoutMs}ms`);
}

/**
 * Extracts verification link and/or code from email
 * @param {Object} message
 * @returns {{link: string|null, code: string|null}}
 */
function extractVerification(message) {
    const html = message.html || message.body || '';
    const text = message.text || message.body || '';

    // Look for common verification link patterns
    const linkPatterns = [
        /href=["'](https?:\/\/[^"']+(?:verify|confirm|activate|verification)[^"']*)["']/i,
        /(https?:\/\/[^\s]+(?:verify|confirm|activate|verification)[^\s]*)/i,
        /href=["'](https?:\/\/[^"']+)["']/gi,
    ];

    let link = null;
    for (const pattern of linkPatterns) {
        const match = html.match(pattern) || text.match(pattern);
        if (match) {
            link = match[1] || match[0];
            // Clean up href="..." wrapper if present
            link = link.replace(/^href=["']|["']$/g, '');
            break;
        }
    }

    // Look for 6-digit verification code
    const codeMatch = text.match(/\b\d{6}\b/) || html.match(/\b\d{6}\b/);
    const code = codeMatch ? codeMatch[0] : null;

    return { link, code };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    generateEmail,
    getMessages,
    waitForMessage,
    extractVerification,
};