// This Cloudflare Worker processes content (link, text, or file) for Base64 operations,
// handles subscription config processing, and converts JSON formatted Shadowsocks configs to ss:// links.
// It supports both single and multiple subscription links via GET parameters to create a mixed, shareable output.

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // --- START CORS HANDLING ---
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Origin': origin || '*', // Allow the specific origin or all if not present
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // Cache preflight response for 24 hours
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }
  // --- END CORS HANDLING ---

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return new Response("Invalid request URL.", { status: 400, headers });
  }

  if (request.method === 'POST') {
    // POST requests are for direct content processing (text/file)
    try {
      const payload = await request.json();
      const { inputType, content, path, mimeType, outputFormat, count, protocols, cloudflareOnly } = payload;

      if (!inputType || !content || !outputFormat || !['text', 'file'].includes(inputType)) {
        return new Response('Invalid POST request. Only "text" and "file" input types are supported via POST.', { status: 400, headers });
      }

      let initialContent = (inputType === 'file') ? atob(content) : content;

      let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(initialContent, inputType);

      // Apply filters
      let currentLines = allExtractedConfigs;
      if (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) {
          const types = protocols.map(t => t.trim().toLowerCase());
          currentLines = currentLines.filter(line => types.some(t => line.toLowerCase().startsWith(`${t}://`)));
      }
      if (cloudflareOnly) {
          currentLines = js_identifyCloudflareDomains(currentLines);
      }
      js_shuffleArray(currentLines);
      if (count && count > 0 && currentLines.length > count) {
          currentLines = currentLines.slice(0, count);
      }
      let finalProcessedContent = currentLines.join('\r\n');

      if (outputFormat === 'base64') {
        finalProcessedContent = js_encodeBase64(finalProcessedContent);
      }

      const jsonResponseHeaders = { ...headers, 'Content-Type': 'application/json' };
      return new Response(JSON.stringify({ content: finalProcessedContent, mimeType: mimeType }), { headers: jsonResponseHeaders });

    } catch (error) {
      console.error('Error in worker POST:', error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500, headers });
    }

  } else if (request.method === 'GET') {
    // GET requests are for on-demand serving from URL parameters (single or multiple links)
    try {
        const singleUrlParam = url.searchParams.get('url');
        const multiUrlParam = url.searchParams.get('urls');

        let targetUrls = [];
        if (multiUrlParam) {
            targetUrls = multiUrlParam.split('|').map(u => u.trim()).filter(Boolean);
        } else if (singleUrlParam) {
            targetUrls.push(singleUrlParam.trim());
        }

        if (targetUrls.length === 0) {
          return new Response('Method Not Allowed or Missing Parameters. Use GET with "url" or "urls" parameter.', { status: 405, headers });
        }
        
        const outputFormat = url.searchParams.get('outputFormat') || 'normal';
        const count = parseInt(url.searchParams.get('count'), 10) || 0;
        const protocols = JSON.parse(decodeURIComponent(url.searchParams.get('protocols') || '[]'));
        const cloudflareOnly = url.searchParams.get('cloudflareOnly') === 'true';
        const downloadFlag = url.searchParams.get('download'); // <-- FIXED THIS LINE
        const pathFromWorkerUrl = url.pathname.substring(1);

        return processContentOnDemand(targetUrls, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, headers);

    } catch(e) {
        console.error("Error in worker GET:", e.message);
        return new Response(`Error processing GET request: ${e.message}`, { status: 500, headers });
    }
  }

  return new Response('Method Not Allowed', { status: 405, headers });
}


/**
 * Processes a list of subscription URLs, fetches their content, applies filters, and returns a final response.
 * @param {string[]} targetUrls - An array of URLs to process.
 * @param {string} outputFormat - The desired output format ('normal' or 'base64').
 * @param {number} count - The maximum number of configs to return.
 * @param {string[]} protocols - An array of protocols to filter by.
 * @param {boolean} cloudflareOnly - Whether to filter for Cloudflare domains only.
 * @param {string} downloadFlag - Whether to trigger a download.
 * @param {string} pathFromWorkerUrl - The filename for downloads.
 * @param {object} corsHeaders - The CORS headers to include in the response.
 * @returns {Promise<Response>} A promise that resolves to a Response object.
 */
async function processContentOnDemand(targetUrls, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, corsHeaders) {
  let filename = pathFromWorkerUrl || 'download.txt';

  // Recursively fetch and extract all configurations from the list of URLs
  let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(targetUrls, 'link');

  let currentLines = allExtractedConfigs;
  
  // Apply protocol filter
  if (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) {
      const types = protocols.map(t => t.trim().toLowerCase());
      currentLines = currentLines.filter(line => types.some(t => line.toLowerCase().startsWith(`${t}://`)));
  }

  // Apply Cloudflare filter
  if (cloudflareOnly) {
      currentLines = js_identifyCloudflareDomains(currentLines);
  }

  js_shuffleArray(currentLines); // Shuffle lines

  // Apply count limit
  if (count && count > 0 && currentLines.length > count) {
      currentLines = currentLines.slice(0, count);
  }
  let finalProcessedContent = currentLines.join('\r\n');

  // Determine MIME type for the response
  let mimeType = 'text/plain; charset=utf-8';

  // Apply desired output format
  if (outputFormat === 'base64') {
    finalProcessedContent = js_encodeBase64(finalProcessedContent);
  } else if (outputFormat !== 'normal') {
    return new Response('Invalid outputFormat.', { status: 400, headers: corsHeaders });
  }

  const finalHeaders = {
    ...corsHeaders,
    'Content-Type': mimeType,
  };

  if (downloadFlag === 'true') {
    finalHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  return new Response(finalProcessedContent, { headers: finalHeaders });
}


/**
 * Recursively fetches content from URLs (including Ssconf:// converted to https://)
 * and extracts all valid configurations, handling Base64 decoding and JSON to ss:// conversion.
 * @param {string|string[]} initialContent - The initial input (array of URL strings for 'link', or raw text content for 'text'/'file').
 * @param {string} initialType - 'link', 'text', or 'file'.
 * @param {number} [maxDepth=3] - Maximum recursion depth for fetching nested URLs.
 * @returns {Promise<string[]>} A promise that resolves to an array of unique extracted configuration lines.
 */
async function recursivelyFetchAndExtractConfigs(initialContent, initialType, maxDepth = 3) {
    let allExtractedConfigs = new Set();
    let urlsToProcessQueue = [];
    let visitedUrls = new Set();

    async function processContentBlock(contentBlock, currentDepth) {
        let processedContent = contentBlock;
        if (js_isBase64(processedContent.trim())) {
            try {
                processedContent = js_decodeBase64(processedContent.trim());
            } catch (e) { /* Ignore decoding errors */ }
        }

        try {
            const parsedJson = JSON.parse(processedContent);
            const configsToAdd = (Array.isArray(parsedJson) ? parsedJson : [parsedJson])
                .map(js_convertJsonToSsLink)
                .filter(Boolean);
            configsToAdd.forEach(link => allExtractedConfigs.add(link));
        } catch (e) { /* Not JSON or not SS JSON, proceed */ }

        const lines = processedContent.split('\n').map(line => line.trim()).filter(line => line);
        for (const line of lines) {
            if (line.match(/^(vless|vmess|ss|ssr|trojan|snell|mieru|anytls|hysteria|hysteria2|tuic|wireguard|ssh|juicity):\/\//i)) {
                allExtractedConfigs.add(line);
            } else if (line.match(/^ssconf:\/\//i)) {
                const httpsUrl = js_replaceSsconf(line);
                if (!visitedUrls.has(httpsUrl)) {
                    urlsToProcessQueue.push({ url: httpsUrl, depth: currentDepth + 1 });
                    visitedUrls.add(httpsUrl);
                }
            } else if (line.match(/^https?:\/\//i)) {
                if (!visitedUrls.has(line)) {
                    urlsToProcessQueue.push({ url: line, depth: currentDepth + 1 });
                    visitedUrls.add(line);
                }
            }
        }
    }

    if (initialType === 'link' && Array.isArray(initialContent)) {
        for (let urlStr of initialContent) {
            if (urlStr.includes('github.com') && urlStr.includes('/blob/')) {
                urlStr = urlStr.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
            }
            if (!visitedUrls.has(urlStr)) {
                urlsToProcessQueue.push({ url: urlStr, depth: 0 });
                visitedUrls.add(urlStr);
            }
        }
    } else if (initialType === 'text' || initialType === 'file') {
        await processContentBlock(initialContent, 0);
    }

    let currentQueueIndex = 0;
    while (currentQueueIndex < urlsToProcessQueue.length) {
        const { url: urlToFetch, depth: currentDepth } = urlsToProcessQueue[currentQueueIndex++];
        if (currentDepth >= maxDepth) continue;
        
        try {
            const response = await fetch(urlToFetch);
            if (response.ok) {
                const fetchedContent = await response.text();
                await processContentBlock(fetchedContent, currentDepth);
            }
        } catch (e) {
            console.error(`Error fetching/processing nested URL ${urlToFetch}: ${e.message}`);
        }
    }

    return Array.from(allExtractedConfigs);
}


function js_isBase64(s) {
    s = s.trim();
    if (!s) return false;
    try {
        return btoa(atob(s)) === s;
    } catch (err) {
        return false;
    }
}

function js_encodeBase64(s) {
    return btoa(unescape(encodeURIComponent(s)));
}

function js_decodeBase64(s) {
    return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
}

function js_shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function js_replaceSsconf(content) {
    return content.replace(/Ssconf:\/\//gi, 'https://');
}

function js_convertJsonToSsLink(jsonConfig) {
    const { method, password, server, server_port, tag } = jsonConfig;
    if (method && password && server && server_port) {
        try {
            const credentials = `${method}:${password}`;
            const encodedCredentials = js_encodeBase64(credentials);
            return `ss://${encodedCredentials}@${server}:${server_port}#${encodeURIComponent(tag || `${server}:${server_port}`)}`;
        } catch (e) {
            return null;
        }
    }
    return null;
}

function js_identifyCloudflareDomains(configLines) {
    const cloudflareDomains = [".workers.dev", ".pages.dev"];
    const identifiedConfigs = new Set();

    for (const line of configLines) {
        try {
            const processedLine = decodeURIComponent(line.replace(/&amp;/g, '&'));
            const parsedUrl = new URL(processedLine);
            const domainsToCheck = new Set([parsedUrl.hostname]);
            
            const queryParams = new URLSearchParams(parsedUrl.search);
            if (queryParams.has('sni')) queryParams.getAll('sni').forEach(d => domainsToCheck.add(d));
            if (queryParams.has('host')) queryParams.getAll('host').forEach(d => domainsToCheck.add(d));

            const scheme = parsedUrl.protocol.slice(0, -1);
            if (['vmess', 'ss'].includes(scheme)) {
                const encodedPart = processedLine.split('://')[1].split('#')[0];
                if (js_isBase64(encodedPart)) {
                    const configData = JSON.parse(js_decodeBase64(encodedPart));
                    if (configData.add) domainsToCheck.add(configData.add);
                    if (configData.host) domainsToCheck.add(configData.host);
                    if (configData.sni) domainsToCheck.add(configData.sni);
                    if (configData.server) domainsToCheck.add(configData.server);
                }
            }
            
            for (let domain of domainsToCheck) {
                const domainName = domain.split(':')[0].toLowerCase();
                if (cloudflareDomains.some(cf_domain => domainName.endsWith(cf_domain))) {
                    identifiedConfigs.add(line);
                    break;
                }
            }
        } catch (e) { /* Ignore parsing errors */ }
    }
    return Array.from(identifiedConfigs);
}
