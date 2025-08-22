// This Cloudflare Worker processes content (link, text, or file), handles subscription config processing,
// and supports advanced filtering based on a prioritized list of protocols with specific counts.

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // --- START CORS HANDLING ---
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
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
    try {
      const payload = await request.json();
      const { inputType, content, path, mimeType, outputFormat, totalCount, protocols, cloudflareOnly } = payload;

      if (!inputType || !content || !outputFormat || !protocols || !['text', 'file'].includes(inputType)) {
        return new Response('Invalid POST request. Missing required parameters.', { status: 400, headers });
      }

      let initialContent = (inputType === 'file') ? atob(content) : content;
      let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(initialContent, inputType);
      
      let finalProcessedContent = processAndFilterConfigs(allExtractedConfigs, protocols, totalCount, cloudflareOnly);

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
        const totalCount = parseInt(url.searchParams.get('totalCount'), 10) || 0;
        const protocols = JSON.parse(decodeURIComponent(url.searchParams.get('protocols') || '[]'));
        const cloudflareOnly = url.searchParams.get('cloudflareOnly') === 'true';
        const downloadFlag = url.searchParams.get('download');
        const pathFromWorkerUrl = url.pathname.substring(1);

        let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(targetUrls, 'link');

        let finalProcessedContent = processAndFilterConfigs(allExtractedConfigs, protocols, totalCount, cloudflareOnly);
        
        if (outputFormat === 'base64') {
            finalProcessedContent = js_encodeBase64(finalProcessedContent);
        } else if (outputFormat !== 'normal') {
            return new Response('Invalid outputFormat.', { status: 400, headers: headers });
        }
        
        const finalHeaders = { ...headers, 'Content-Type': 'text/plain; charset=utf-8' };
        if (downloadFlag === 'true') {
            finalHeaders['Content-Disposition'] = `attachment; filename="${pathFromWorkerUrl || 'download.txt'}"`;
        }

        return new Response(finalProcessedContent, { headers: finalHeaders });

    } catch(e) {
        console.error("Error in worker GET:", e.message);
        return new Response(`Error processing GET request: ${e.message}`, { status: 500, headers });
    }
  }

  return new Response('Method Not Allowed', { status: 405, headers });
}

/**
 * Applies all filtering, ordering, and counting logic to a list of configs.
 * @param {string[]} allConfigs - Array of all available config strings.
 * @param {Array<{protocol: string, count: number}>} protocolPriorityList - The user-defined priority list.
 * @param {number} totalCount - The absolute maximum number of configs to return.
 * @param {boolean} cloudflareOnly - Whether to filter for Cloudflare domains.
 * @returns {string} The final, processed string of configs.
 */
function processAndFilterConfigs(allConfigs, protocolPriorityList, totalCount, cloudflareOnly) {
    let filteredConfigs = allConfigs;
    if (cloudflareOnly) {
        filteredConfigs = js_identifyCloudflareDomains(filteredConfigs);
    }

    const groupedConfigs = groupConfigsByProtocol(filteredConfigs, protocolPriorityList);
    
    let finalOrderedConfigs = [];
    
    // First pass: Add configs with a specific count, respecting priority order
    protocolPriorityList.forEach(p => {
        if (p.count > 0) {
            const configsForProtocol = groupedConfigs[p.protocol] || [];
            const configsToAdd = configsForProtocol.splice(0, p.count);
            finalOrderedConfigs.push(...configsToAdd);
        }
    });

    // Second pass: Add configs with "unlimited" count (0), respecting priority order
    protocolPriorityList.forEach(p => {
        if (p.count === 0) {
            const remainingConfigs = groupedConfigs[p.protocol] || [];
            finalOrderedConfigs.push(...remainingConfigs);
        }
    });

    // Apply the total count limit if it's specified
    if (totalCount > 0 && finalOrderedConfigs.length > totalCount) {
        finalOrderedConfigs = finalOrderedConfigs.slice(0, totalCount);
    }

    return finalOrderedConfigs.join('\r\n');
}

/**
 * Groups an array of config strings by their protocol type based on the priority list.
 * @param {string[]} configLines - Array of config strings.
 * @param {Array<{protocol: string, count: number}>} protocolPriorityList - The user-defined priority list.
 * @returns {Object.<string, string[]>} An object where keys are protocol identifiers and values are arrays of configs.
 */
function groupConfigsByProtocol(configLines, protocolPriorityList) {
    const grouped = {};
    const protocolMap = new Map();

    // Create a map for quick lookup: e.g., 'vless' -> 'vless', 'hy2' -> 'hysteria2,hy2'
    protocolPriorityList.forEach(p => {
        const types = p.protocol.split(',').map(t => t.trim().toLowerCase());
        types.forEach(type => protocolMap.set(type, p.protocol));
    });

    js_shuffleArray(configLines);

    configLines.forEach(line => {
        const match = line.match(/^([a-z0-9]+):\/\//i);
        if (match) {
            const protocolType = match[1].toLowerCase();
            const groupKey = protocolMap.get(protocolType);
            if (groupKey) {
                if (!grouped[groupKey]) {
                    grouped[groupKey] = [];
                }
                grouped[groupKey].push(line);
            }
        }
    });

    return grouped;
}

/**
 * Recursively fetches content from URLs and extracts all valid configurations.
 * @param {string|string[]} initialContent - The initial input.
 * @param {string} initialType - 'link', 'text', or 'file'.
 * @param {number} [maxDepth=3] - Maximum recursion depth.
 * @returns {Promise<string[]>} A promise that resolves to an array of unique extracted config lines.
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
        } catch (e) { /* Not JSON, proceed */ }

        const lines = processedContent.split('\n').map(line => line.trim()).filter(line => line);
        for (const line of lines) {
            if (line.match(/^(vless|vmess|ss|ssr|trojan|snell|mieru|anytls|hysteria|hysteria2|hy2|tuic|wireguard|ssh|juicity|warp|socks5|mtproto):\/\//i)) {
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


// --- HELPER FUNCTIONS ---
function js_isBase64(s) { s = s.trim(); if (!s) return false; try { return btoa(atob(s)) === s; } catch (err) { return false; } }
function js_encodeBase64(s) { return btoa(unescape(encodeURIComponent(s))); }
function js_decodeBase64(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }
function js_shuffleArray(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }
function js_replaceSsconf(content) { return content.replace(/Ssconf:\/\//gi, 'https://'); }
function js_convertJsonToSsLink(jsonConfig) { const { method, password, server, server_port, tag } = jsonConfig; if (method && password && server && server_port) { try { const credentials = `${method}:${password}`; const encodedCredentials = js_encodeBase64(credentials); return `ss://${encodedCredentials}@${server}:${server_port}#${encodeURIComponent(tag || `${server}:${server_port}`)}`; } catch (e) { return null; } } return null; }

/**
 * Identifies configs that use Cloudflare worker domains in their address, SNI, or host fields.
 * This is an improved, more comprehensive version.
 * @param {string[]} configLines - An array of config strings.
 * @returns {string[]} An array of configs identified as using Cloudflare.
 */
function js_identifyCloudflareDomains(configLines) {
    const cloudflareDomains = [".workers.dev", ".pages.dev"];
    const identifiedConfigs = new Set();

    for (const line of configLines) {
        try {
            // A set to hold all domains/addresses found in the config line
            const domainsToCheck = new Set();
            const protocol = line.split('://')[0].toLowerCase();
            
            if (['vless', 'trojan', 'ss'].includes(protocol)) {
                // For vless/trojan/ss: user@address:port?params#name
                const urlPart = line.split('#')[0];
                const parsedUrl = new URL(urlPart);
                domainsToCheck.add(parsedUrl.hostname);

                // Check common query parameters for actual domain/SNI
                if (parsedUrl.searchParams.has('sni')) domainsToCheck.add(parsedUrl.searchParams.get('sni'));
                if (parsedUrl.searchParams.has('host')) domainsToCheck.add(parsedUrl.searchParams.get('host'));
                if (parsedUrl.searchParams.has('peer')) domainsToCheck.add(parsedUrl.searchParams.get('peer'));

            } else if (protocol === 'vmess') {
                // For vmess: vmess://BASE64
                const b64 = line.substring(8);
                const config = JSON.parse(js_decodeBase64(b64));
                if (config.add) domainsToCheck.add(config.add);
                if (config.host) domainsToCheck.add(config.host);
                if (config.sni) domainsToCheck.add(config.sni);
            }

            // Check all collected domains against the Cloudflare list
            for (let domain of domainsToCheck) {
                const domainName = domain.split(':')[0].toLowerCase(); // Remove port if present
                if (cloudflareDomains.some(cf_domain => domainName.endsWith(cf_domain))) {
                    identifiedConfigs.add(line);
                    break; // Once identified, no need to check other domains for this line
                }
            }
        } catch (e) {
            // Ignore lines that cannot be parsed
        }
    }
    return Array.from(identifiedConfigs);
}
