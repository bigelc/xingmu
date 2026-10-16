// Electron's session.fetch rejects a manual 302 instead of exposing its
// Location. This adapter returns that response for the article service to
// validate, without allowing Chromium to follow any redirect itself.
const ARTICLE_FETCH_MAX_BYTES = 4 * 1024 * 1024;

function createArticleFetch({ net, session, maxBytes = ARTICLE_FETCH_MAX_BYTES }) {
  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, ARTICLE_FETCH_MAX_BYTES) : ARTICLE_FETCH_MAX_BYTES;
  return (value, options = {}) => new Promise((resolve, reject) => {
    let url;
    try { url = new URL(value); } catch { reject(new Error('unsafe_url')); return; }
    if (url.protocol !== 'https:' || url.username || url.password || (options.method && options.method !== 'GET')) {
      reject(new Error('unsafe_url')); return;
    }
    const signal = options.signal;
    const abortError = () => new DOMException('The operation was aborted', 'AbortError');
    if (signal?.aborted) { reject(abortError()); return; }
    let request;
    let bodyController;
    let finished = false;
    let responded = false;
    let receivedBytes = 0;
    const abortRequest = () => { try { request?.abort(); } catch {} };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    function fail(error) {
      if (finished) return;
      finished = true;
      cleanup();
      if (!responded) reject(error);
      else { try { bodyController?.error(error); } catch {} }
      abortRequest();
    }
    function onAbort() { fail(abortError()); }
    function headersFrom(raw) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(raw || {})) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry != null) headers.append(name, String(entry));
        }
      }
      return headers;
    }
    try {
      const accept = new Headers(options.headers).get('accept');
      request = net.request({
        url: url.href, session, method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: accept ? { Accept: accept } : {},
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      request.on('error', fail);
      request.on('abort', () => { if (!finished) fail(abortError()); });
      request.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
        if (finished) return;
        try {
          const headers = headersFrom(responseHeaders);
          headers.set('location', redirectUrl);
          const response = new Response(null, { status: statusCode, headers });
          responded = true;
          finished = true;
          cleanup();
          resolve(response);
          // Do not call followRedirect: the next target must first pass the
          // service's public HTTPS validator in a separate request.
          abortRequest();
        } catch (error) { fail(error); }
      });
      request.on('response', (incoming) => {
        if (finished) return;
        try {
          const headers = headersFrom(incoming.headers);
          if (Number(headers.get('content-length')) > byteLimit) { fail(new Error('response_too_large')); return; }
          const noBody = [204, 205, 304].includes(incoming.statusCode);
          const body = noBody ? null : new ReadableStream({
            start(controller) { bodyController = controller; },
            cancel() {
              if (finished) return;
              finished = true;
              cleanup();
              abortRequest();
            },
          });
          // Electron documents that end must be registered before data.
          incoming.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();
            try { bodyController?.close(); } catch {}
          });
          incoming.on('error', fail);
          incoming.on('aborted', () => fail(abortError()));
          incoming.on('data', (chunk) => {
            if (finished) return;
            receivedBytes += chunk.byteLength;
            if (receivedBytes > byteLimit) { fail(new Error('response_too_large')); return; }
            if (bodyController) {
              try { bodyController.enqueue(new Uint8Array(chunk)); } catch (error) { fail(error); }
            }
          });
          const response = new Response(body, { status: incoming.statusCode, headers });
          responded = true;
          resolve(response);
        } catch (error) { fail(error); }
      });
      request.end();
    } catch (error) { fail(error); }
  });
}

module.exports = { createArticleFetch, ARTICLE_FETCH_MAX_BYTES };
