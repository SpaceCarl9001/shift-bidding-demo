// A paced client for the Assembled API. Assembled allows 300 requests a minute (5 a second, with
// short bursts of up to 20) and answers 429 when that is exceeded. Requests made through one
// client are spaced to stay under the limit, and a 429 is retried after a short wait.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assembledClient(apiKey, { perSecond = 4, retries = 4 } = {}) {
  const headers = { Authorization: "Basic " + Buffer.from(apiKey + ":").toString("base64"), "Content-Type": "application/json" };
  const gap = 1000 / perSecond;
  let nextSlot = 0;
  async function call(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now(), at = Math.max(now, nextSlot);
      nextSlot = at + gap;
      if (at > now) await sleep(at - now);
      const r = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (r.status !== 429 || attempt >= retries) return r;
      await sleep(1000 * (attempt + 1));
    }
  }
  return { call, headers };
}

module.exports = { assembledClient };
