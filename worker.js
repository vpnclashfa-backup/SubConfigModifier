// This Cloudflare Worker processes content (link, text, or file) for Base64 operations,
// and now also handles subscription config processing from a config.txt content,
// and converts JSON formatted Shadowsocks configs to ss:// links.

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

  // Handle CORS preflight requests (OPTIONS method)
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }
  // --- END CORS HANDLING ---

  let url; // Define url here to be accessible throughout the function.
  try {
    url = new URL(request.url); // Place URL construction in try-catch.
  } catch (e) {
    console.error("Error parsing request URL:", e);
    return new Response("Invalid request URL.", { status: 400, headers }); // Return error if URL is invalid.
  }

  // Now proceed with the actual request logic (GET or POST)
  if (request.method === 'POST') {
    try {
      const payload = await request.json();
      const { inputType, content, path, mimeType, outputFormat, count, protocols, cloudflareOnly } = payload;

      if (!inputType || !content || !path || !outputFormat) {
        return new Response('Missing required fields (inputType, content, path, outputFormat).', { status: 400, headers });
      }

      let initialContent;
      let finalMimeType = mimeType; // This mimeType is only for file input type

      // Step 1: Get the initial content based on inputType
      if (inputType === 'link') {
        initialContent = content; // This is the URL string
      } else if (inputType === 'text') {
        initialContent = content; // This is the raw text string
      } else if (inputType === 'file') {
        initialContent = atob(content); // This is the decoded binary string from base64
      } else {
        return new Response('Invalid inputType.', { status: 400, headers });
      }

      // Step 2: Recursively fetch and extract all configurations
      // This function will handle Ssconf:// conversion, Base64 decoding, and nested fetching
      let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(initialContent, inputType);

      // Step 3: Apply config filtering/shuffling based on user options
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
      if (count !== 0 && currentLines.length > count) {
          currentLines = currentLines.slice(0, count);
      }
      let finalProcessedContent = currentLines.join('\r\n');


      // Step 4: Apply desired output format
      if (outputFormat === 'base64') {
        finalProcessedContent = js_encodeBase64(finalProcessedContent);
      } else if (outputFormat !== 'normal') {
        return new Response('Invalid outputFormat. Choose "normal" or "base64".', { status: 400, headers });
      }

      // Step 5: Return the result
      const jsonResponseHeaders = { ...headers, 'Content-Type': 'application/json' }; // Merge CORS headers
      
      if (inputType === 'link') {
        // For links, return a URL to this worker itself, with query params for on-demand processing
        // The on-demand processing will handle the outputFormat and potential re-encoding
        const resultUrl = `${url.origin}/${path}?url=${encodeURIComponent(content)}&outputFormat=${outputFormat}&count=${count}&protocols=${encodeURIComponent(JSON.stringify(protocols))}&cloudflareOnly=${cloudflareOnly}`;
        return new Response(JSON.stringify({ url: resultUrl }), { headers: jsonResponseHeaders });
      } else {
        // For text/file, return the processed content directly in the JSON response
        return new Response(JSON.stringify({ content: finalProcessedContent, mimeType: finalMimeType }), { headers: jsonResponseHeaders });
      }

    } catch (error) {
      console.error('Error in worker POST:', error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500, headers });
    }
  } else { // GET request for on-demand serving
    const targetUrlParam = url.searchParams.get('url');
    const outputFormat = url.searchParams.get('outputFormat');
    const count = parseInt(url.searchParams.get('count'), 10);
    const protocols = JSON.parse(decodeURIComponent(url.searchParams.get('protocols') || '[]'));
    const cloudflareOnly = url.searchParams.get('cloudflareOnly') === 'true';
    const downloadFlag = url.searchParams.get('download');
    const pathFromWorkerUrl = url.pathname.substring(1);

    if (targetUrlParam && outputFormat) {
      return processContentOnDemand(targetUrlParam, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, headers);
    } else {
      return new Response('Method Not Allowed or Missing Parameters. Use POST for processing content, or GET with url/outputFormat for on-demand serving.', { status: 405, headers });
    }
  }
}

/**
 * Recursively fetches content from URLs (including Ssconf:// converted to https://)
 * and extracts all valid configurations, handling Base64 decoding and JSON to ss:// conversion.
 * It also identifies and queues new subscription-like URLs found within fetched content.
 * @param {string} initialContent - The initial input (URL string, or raw text content).
 * @param {string} initialType - 'link', 'text', or 'file'.
 * @param {number} [maxDepth=3] - Maximum recursion depth for fetching nested URLs.
 * @returns {Promise<string[]>} A promise that resolves to an array of unique extracted configuration lines.
 */
async function recursivelyFetchAndExtractConfigs(initialContent, initialType, maxDepth = 3) {
    let allExtractedConfigs = new Set(); // Stores unique final configurations (e.g., vless://, ss://)
    let urlsToProcessQueue = []; // URLs that need to be fetched and parsed
    let visitedUrls = new Set(); // To prevent infinite loops and redundant fetches

    // Helper function to process a block of text, extract configs, and find new URLs
    async function processContentBlock(contentBlock, currentDepth) {
        // Auto-detect and decode Base64 if applicable
        let processedContentForJsonAndDirectLinks = contentBlock;
        if (js_isBase64(processedContentForJsonAndDirectLinks.trim())) {
            try {
                processedContentForJsonAndDirectLinks = js_decodeBase64(processedContentForJsonAndDirectLinks.trim());
            } catch (e) {
                console.warn(`Content block looked like Base64 but failed to decode, treating as plain: ${e.message}`);
            }
        }

        // --- Try to parse as JSON and convert to ss:// if it matches the format ---
        try {
            const parsedJson = JSON.parse(processedContentForJsonAndDirectLinks);
            let configsToAdd = [];

            if (Array.isArray(parsedJson)) {
                for (const item of parsedJson) {
                    const ssLink = js_convertJsonToSsLink(item);
                    if (ssLink) {
                        configsToAdd.push(ssLink);
                    }
                }
            } else if (typeof parsedJson === 'object' && parsedJson !== null) {
                const ssLink = js_convertJsonToSsLink(parsedJson);
                if (ssLink) {
                    configsToAdd.push(ssLink);
                }
            }
            configsToAdd.forEach(link => allExtractedConfigs.add(link));

        } catch (e) {
            // Not a valid JSON or not a config JSON, proceed to other parsing
            // console.log("Not a JSON config or invalid JSON:", e.message); // Keep this commented for production
        }

        const lines = processedContentForJsonAndDirectLinks.split('\n').map(line => line.trim()).filter(line => line);

        for (const line of lines) {
            // Check if it's an ssconf:// link specifically
            if (line.match(/^ssconf:\/\//i)) {
                const httpsUrl = js_replaceSsconf(line); // Convert ssconf:// to https://
                try {
                    const urlObj = new URL(httpsUrl); // Validate it's a valid URL after conversion
                    if (!visitedUrls.has(urlObj.href)) {
                        urlsToProcessQueue.push({ url: urlObj.href, depth: currentDepth + 1 });
                        visitedUrls.add(urlObj.href);
                    }
                } catch (e) {
                    console.warn(`Invalid ssconf converted URL: ${httpsUrl}, Error: ${e.message}`);
                }
            }
            // Check if it's a direct config (e.g., vless://, ss://, etc.)
            else if (line.match(/^(vless|vmess|ss|ssr|trojan|snell|mieru|anytls|hysteria|hysteria2|tuic|wireguard|ssh|juicity):\/\//i)) {
                allExtractedConfigs.add(line);
            }
            // Check if it's a potential subscription URL (general HTTP/HTTPS)
            else if (line.match(/^https?:\/\//i)) {
                try {
                    const url = new URL(line);
                    // Heuristic: check for common subscription file extensions or known cloud storage domains
                    const isSubscriptionLike = url.pathname.endsWith('.txt') || url.pathname.endsWith('.csv') ||
                                               url.pathname.endsWith('.yaml') || url.pathname.endsWith('.yml') ||
                                               url.hostname.includes('drive.google.com') ||
                                               url.hostname.includes('s3.amazonaws.com') ||
                                               url.hostname.includes('raw.githubusercontent.com') ||
                                               url.hostname.includes('cdn.jsdelivr.net');

                    if (isSubscriptionLike && !visitedUrls.has(url.href)) {
                        urlsToProcessQueue.push({ url: url.href, depth: currentDepth + 1 });
                        visitedUrls.add(url.href);
                    }
                } catch (e) {
                    // Ignore invalid URLs
                }
            }
        }
    }

    // Initial processing based on inputType
    if (initialType === 'link') {
        let initialUrl = initialContent; // Keep original as it might be ssconf://
        // Convert ssconf:// to https:// for the initial link if it's ssconf://
        if (initialUrl.match(/^ssconf:\/\//i)) {
            initialUrl = js_replaceSsconf(initialUrl);
        }
        // Convert GitHub blob URLs to raw format for the initial link if it's a direct link input
        if (initialUrl.includes('github.com') && initialUrl.includes('/blob/')) {
            initialUrl = initialUrl
                .replace('github.com', 'raw.githubusercontent.com')
                .replace('/blob/', '/');
        }
        if (!visitedUrls.has(initialUrl)) {
            urlsToProcessQueue.push({ url: initialUrl, depth: 0 }); // Initial depth is 0
            visitedUrls.add(initialUrl);
        }
    } else { // 'text' or 'file'
        // For text/file, process the content block directly.
        // The processContentBlock will handle ssconf:// conversion for lines within the text.
        await processContentBlock(initialContent, 0); // Initial depth is 0 for direct content
    }

    let currentQueueIndex = 0;
    // Process URLs in the queue iteratively with a depth limit
    while (currentQueueIndex < urlsToProcessQueue.length) {
        const { url: urlToFetch, depth: currentDepth } = urlsToProcessQueue[currentQueueIndex++];

        if (currentDepth >= maxDepth) {
            console.log(`Max depth (${maxDepth}) reached for URL: ${urlToFetch}. Skipping further recursion.`);
            continue;
        }
        
        try {
            const response = await fetch(urlToFetch);
            if (response.ok) {
                const fetchedContent = await response.text();
                await processContentBlock(fetchedContent, currentDepth); // Pass currentDepth to processContentBlock
            } else {
                console.warn(`Failed to fetch nested URL: ${urlToFetch}, Status: ${response.status}`);
            }
        } catch (e) {
            console.error(`Error fetching or processing nested URL ${urlToFetch}: ${e.message}`);
        }
    }

    return Array.from(allExtractedConfigs); // Return unique configs as an array
}


// Helper functions (translated from Python script)

// Checks if a string is a valid Base64 string
function js_isBase64(s) {
    s = s.trim();
    if (!s) {
        return false;
    }
    try {
        // Add padding if missing
        const missing_padding = s.length % 4;
        if (missing_padding !== 0) {
            s += '='.repeat(4 - missing_padding);
        }
        atob(s); // Try to decode
        return true;
    } catch (e) {
        return false;
    }
}

// Encodes a UTF-8 string to Base64
function js_encodeBase64(s) {
    return btoa(unescape(encodeURIComponent(s)));
}

// Decodes a Base64 string to UTF-8
function js_decodeBase64(s) {
    // Add padding if missing
    const missing_padding = s.length % 4;
    if (missing_padding !== 0) {
        s += '='.repeat(4 - missing_padding);
    }
    return decodeURIComponent(escape(atob(s)));
}

// Shuffles an array (Fisher-Yates)
function js_shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

/**
 * Replaces 'Ssconf://' with 'https://' in a string, case-insensitively.
 * @param {string} content - The string to process.
 * @returns {string} The processed string with replacements.
 */
function js_replaceSsconf(content) {
    // Use a regular expression with 'gi' flags for global and case-insensitive replacement
    return content.replace(/Ssconf:\/\//gi, 'https://');
}

/**
 * Converts a JSON object representing a Shadowsocks config to an ss:// link.
 * @param {object} jsonConfig - The parsed JSON object.
 * @returns {string|null} The ss:// link or null if conversion fails.
 */
function js_convertJsonToSsLink(jsonConfig) {
    const { method, password, server, server_port } = jsonConfig;

    if (method && password && server && server_port) {
        try {
            const credentials = `${method}:${password}`;
            const encodedCredentials = js_encodeBase64(credentials); // Use existing helper
            // Ensure server_port is a number
            const port = parseInt(server_port, 10);
            if (isNaN(port)) {
                console.warn(`Invalid server_port in JSON config: ${server_port}`);
                return null;
            }
            // Add a default tag if not present, or use server:port
            const tag = jsonConfig.tag || `${server}:${port}`; // Assuming 'tag' field might exist in JSON
            // URL-encode the tag
            const encodedTag = encodeURIComponent(tag);

            return `ss://${encodedCredentials}@${server}:${port}#${encodedTag}`;
        } catch (e) {
            console.error(`Error converting JSON to SS link: ${e.message}`, jsonConfig);
            return null;
        }
    }
    return null; // Not a valid SS JSON config (missing required fields)
}


// Identifies Cloudflare Worker/Pages domains in config lines
function js_identifyCloudflareDomains(configLines) {
    const cloudflareDomains = [".workers.dev", ".pages.dev"];
    const identifiedConfigs = new Set(); // Use a Set to avoid duplicates

    for (const line of configLines) {
        try {
            // Replace HTML special characters like '&amp;' with '&' and URL-decode
            const processedLine = decodeURIComponent(line.replace(/&amp;/g, '&'));
            
            const parsedUrl = new URL(processedLine);
            const scheme = parsedUrl.protocol.toLowerCase().replace(':', '');
            
            const domainsToCheck = [];

            // 1. Check main server address (hostname)
            let hostname = parsedUrl.hostname;
            if (hostname) {
                domainsToCheck.push(hostname);
            }

            // 2. Check 'sni' and 'host' parameters in query string
            const queryParams = new URLSearchParams(parsedUrl.search);
            if (queryParams.has('sni')) {
                domainsToCheck.push(...queryParams.getAll('sni'));
            }
            if (queryParams.has('host')) {
                domainsToCheck.push(...queryParams.getAll('host'));
            }

            // 3. Handle Base64 protocols (VMess, some SS)
            if (['vmess', 'ss'].includes(scheme)) {
                let encodedPartOfConfig = processedLine.split('://', 2)[1];
                if (encodedPartOfConfig.includes('#')) {
                    encodedPartOfConfig = encodedPartOfConfig.split('#', 2)[0];
                }
                
                if (js_isBase64(encodedPartOfConfig)) {
                    try {
                        const decodedJsonStr = js_decodeBase64(encodedPartOfConfig);
                        const configData = JSON.parse(decodedJsonStr);
                        
                        // For VMess: 'add' (address), 'host', 'sni'
                        if (configData.add) domainsToCheck.push(configData.add);
                        if (configData.host) domainsToCheck.push(configData.host);
                        if (configData.sni) domainsToCheck.push(configData.sni);
                        
                        // For SS: usually 'server' (though SS uses JSON less frequently)
                        if (scheme === 'ss') { // Check for SS specific fields within decoded JSON
                            if (configData.server) domainsToCheck.push(configData.server);
                            // SS links can also have 'host' or 'sni' in their JSON, depending on transport
                            if (configData.host) domainsToCheck.push(configData.host);
                            if (configData.sni) domainsToCheck.push(configData.sni);
                        }
                    } catch (e) {
                        // Ignore if Base64 but not valid JSON or decoding issue
                        // console.warn(`Error decoding/parsing Base64 config: ${e.message}`);
                    }
                }
            }
            
            // Final check of collected domains
            for (let domain of domainsToCheck) {
                // Ensure domain only includes the domain part without port
                if (domain.includes(':')) {
                    domain = domain.split(':')[0];
                }
                
                if (cloudflareDomains.some(cf_domain => domain.toLowerCase().endsWith(cf_domain))) {
                    identifiedConfigs.add(line);
                    break; // Found a Cloudflare domain, move to next line
                }
            }

        } catch (e) {
            // Ignore errors in parsing a line, move to next
            // console.error(`Error processing line for Cloudflare identification: ${line} - ${e.message}`);
            continue;
        }
    }
    return Array.from(identifiedConfigs); // Return unique configs as an array
}

// Handles GET requests to serve content on demand (existing functionality, updated for new params)
async function processContentOnDemand(targetUrlParam, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, corsHeaders) {
  let initialContent = targetUrlParam; // The URL to fetch
  let filename = pathFromWorkerUrl || 'download';

  // Recursively fetch and extract all configurations
  let allExtractedConfigs = await recursivelyFetchAndExtractConfigs(initialContent, 'link');

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
  if (count !== 0 && currentLines.length > count) {
      currentLines = currentLines.slice(0, count);
  }
  let finalProcessedContent = currentLines.join('\r\n');

  // Determine MIME type for the response
  let mimeType = 'text/plain'; // Default to text/plain
  if (outputFormat === 'base64') {
      mimeType = 'text/plain'; // Base64 is still text
  } else {
      // Try to infer from filename if it has a common config extension
      if (filename.endsWith('.txt') || filename.endsWith('.csv') || filename.endsWith('.yaml') || filename.endsWith('.yml')) {
          mimeType = 'text/plain'; // Or more specific like text/csv, application/x-yaml
      } else {
          mimeType = 'application/octet-stream'; // Generic binary for unknown types
      }
  }


  // Apply desired output format
  if (outputFormat === 'base64') {
    finalProcessedContent = js_encodeBase64(finalProcessedContent);
  } else if (outputFormat !== 'normal') {
    return new Response('Invalid outputFormat.', { status: 400, headers: corsHeaders });
  }

  // Merge CORS headers with content-specific headers
  const finalHeaders = {
    ...corsHeaders,
    'Content-Type': mimeType,
  };

  if (downloadFlag === 'true') {
    finalHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  return new Response(finalProcessedContent, { headers: finalHeaders });
}
