// This Cloudflare Worker processes content (link, text, or file) for Base64 operations,
// and now also handles subscription config processing from a config.txt content.

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

      let rawContentFromInput;
      let finalMimeType = mimeType;

      // Step 1: Get the raw content based on inputType
      if (inputType === 'link') {
        let targetUrl = content;
        // Convert GitHub blob URLs to raw format
        if (targetUrl.includes('github.com') && targetUrl.includes('/blob/')) {
          targetUrl = targetUrl
            .replace('github.com', 'raw.githubusercontent.com')
            .replace('/blob/', '/');
        }

        const fetchResponse = await fetch(targetUrl);
        if (!fetchResponse.ok) {
          return new Response(`Error fetching content from link: ${fetchResponse.status} - ${await fetchResponse.text()}`, { status: fetchResponse.status, headers });
        }
        rawContentFromInput = await fetchResponse.text();
        const contentTypeHeader = fetchResponse.headers.get('Content-Type');
        if (contentTypeHeader && !mimeType) {
            finalMimeType = contentTypeHeader.split(';')[0];
        } else if (!mimeType) {
            finalMimeType = 'text/plain';
        }

      } else if (inputType === 'text') {
        rawContentFromInput = content;
      } else if (inputType === 'file') {
        rawContentFromInput = atob(content); // content is already base64 from frontend
      } else {
        return new Response('Invalid inputType.', { status: 400, headers });
      }

      // Step 2: Auto-detect and decode Base64 input if applicable
      let processedContent = rawContentFromInput;
      if (js_isBase64(processedContent.trim())) {
          try {
              processedContent = js_decodeBase64(processedContent.trim());
          } catch (e) {
              // If it looks like Base64 but fails to decode, treat as plain text.
              // This can happen if it's not a valid Base64 string for text.
              console.warn(`Content looked like Base64 but failed to decode, treating as plain: ${e.message}`);
          }
      }

      // Step 3: Apply config filtering/shuffling if options are provided
      // Determine if config processing is desired based on parameters
      const applyConfigProcessing = (count !== undefined && count !== null && count !== 0) || 
                                    (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) || 
                                    cloudflareOnly;

      if (applyConfigProcessing) {
          let currentLines = processedContent.split('\n')
                                            .map(line => line.trim())
                                            .filter(line => line && !line.startsWith('#'));
          
          // Apply protocol filter
          if (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) {
              const types = protocols.map(t => t.trim().toLowerCase());
              currentLines = currentLines.filter(line => types.some(t => line.toLowerCase().startsWith(`${t}://`)));
          }

          // Apply Cloudflare filter
          let cloudflareConfigs = [];
          if (cloudflareOnly) {
              cloudflareConfigs = js_identifyCloudflareDomains(currentLines);
              currentLines = cloudflareConfigs; // If cloudflareOnly is true, only keep CF configs
          }

          js_shuffleArray(currentLines); // Shuffle lines

          // Apply count limit
          if (count !== 0 && currentLines.length > count) {
              currentLines = currentLines.slice(0, count);
          }
          processedContent = currentLines.join('\r\n');
      }


      // Step 4: Apply desired output format
      if (outputFormat === 'base64') {
        processedContent = js_encodeBase64(processedContent);
      } else if (outputFormat !== 'normal') {
        return new Response('Invalid outputFormat. Choose "normal" or "base64".', { status: 400, headers });
      }

      // Step 5: Return the result based on inputType
      const jsonResponseHeaders = { ...headers, 'Content-Type': 'application/json' }; // Merge CORS headers
      
      if (inputType === 'link') {
        // For links, return a URL to this worker itself, with query params for on-demand processing
        // The on-demand processing will handle the outputFormat and potential re-encoding
        const resultUrl = `${url.origin}/${path}?url=${encodeURIComponent(content)}&outputFormat=${outputFormat}&count=${count}&protocols=${encodeURIComponent(JSON.stringify(protocols))}&cloudflareOnly=${cloudflareOnly}`;
        return new Response(JSON.stringify({ url: resultUrl }), { headers: jsonResponseHeaders });
      } else {
        // For text/file, return the processed content directly in the JSON response
        return new Response(JSON.stringify({ content: processedContent, mimeType: finalMimeType }), { headers: jsonResponseHeaders });
      }

    } catch (error) {
      console.error('Error in worker POST:', error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500, headers });
    }
  } else { // GET request for on-demand serving
    // url is already defined and validated above
    const targetUrlParam = url.searchParams.get('url');
    const outputFormat = url.searchParams.get('outputFormat'); // New: output format for on-demand
    const count = parseInt(url.searchParams.get('count'), 10); // New: count for on-demand
    const protocols = JSON.parse(decodeURIComponent(url.searchParams.get('protocols') || '[]')); // New: protocols for on-demand
    const cloudflareOnly = url.searchParams.get('cloudflareOnly') === 'true'; // New: cloudflareOnly for on-demand
    const downloadFlag = url.searchParams.get('download');
    const pathFromWorkerUrl = url.pathname.substring(1);

    if (targetUrlParam && outputFormat) {
      // This is a request to serve content on demand
      return processContentOnDemand(targetUrlParam, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, headers); // Pass all new parameters
    } else {
      return new Response('Method Not Allowed or Missing Parameters. Use POST for processing content, or GET with url/outputFormat for on-demand serving.', { status: 405, headers });
    }
  }
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

// Identifies Cloudflare Worker/Pages domains in config lines
function js_identifyCloudflareDomains(configLines) {
    const cloudflareDomains = [".workers.dev", ".pages.dev"];
    const identifiedConfigs = [];

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
                        if (scheme === 'vmess') {
                            if (configData.add) domainsToCheck.push(configData.add);
                            if (configData.host) domainsToCheck.push(configData.host);
                            if (configData.sni) domainsToCheck.push(configData.sni);
                        }
                        // For SS: usually 'server' (though SS uses JSON less frequently)
                        else if (scheme === 'ss') {
                            if (configData.server) domainsToCheck.push(configData.server);
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
                    identifiedConfigs.push(line);
                    break; // Found a Cloudflare domain, move to next line
                }
            }

        } catch (e) {
            // Ignore errors in parsing a line, move to next
            // console.error(`Error processing line for Cloudflare identification: ${line} - ${e.message}`);
            continue;
        }
    }
    return identifiedConfigs;
}

// Handles GET requests to serve content on demand (existing functionality, updated for new params)
async function processContentOnDemand(targetUrlParam, outputFormat, count, protocols, cloudflareOnly, downloadFlag, pathFromWorkerUrl, corsHeaders) {
  let finalTargetUrl = targetUrlParam;
  if (finalTargetUrl.includes('github.com') && finalTargetUrl.includes('/blob/')) {
    finalTargetUrl = finalTargetUrl
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/blob/', '/');
  }

  let content;
  let mimeType = 'text/plain';
  let filename = pathFromWorkerUrl || 'download';

  try {
    const fetchResponse = await fetch(finalTargetUrl);
    if (!fetchResponse.ok) {
      return new Response(`Error fetching content: ${fetchResponse.status} - ${await fetchResponse.text()}`, { status: fetchResponse.status, headers: corsHeaders });
    }
    content = await fetchResponse.text();
    const contentTypeHeader = fetchResponse.headers.get('Content-Type');
    if (contentTypeHeader) {
        mimeType = contentTypeHeader.split(';')[0];
    }
    try {
        const originalUrlObj = new URL(targetUrlParam);
        const pathSegments = originalUrlObj.pathname.split('/');
        const lastSegment = pathSegments[pathSegments.length - 1];
        if (lastSegment && lastSegment.includes('.')) {
            filename = lastSegment;
        }
    } catch (e) {
        // Ignore URL parsing errors
    }

  } catch (error) {
    return new Response(`Error fetching content: ${error.message}`, { status: 500, headers: corsHeaders });
  }

  // Auto-detect and decode Base64 input if applicable
  let processedContent = content;
  if (js_isBase64(processedContent.trim())) {
      try {
          processedContent = js_decodeBase64(processedContent.trim());
      } catch (e) {
          console.warn(`Content looked like Base64 but failed to decode on-demand, treating as plain: ${e.message}`);
      }
  }

  // Apply config filtering/shuffling if options are provided
  const applyConfigProcessing = (count !== undefined && count !== null && count !== 0) || 
                                (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) || 
                                cloudflareOnly;

  if (applyConfigProcessing) {
      let currentLines = processedContent.split('\n')
                                        .map(line => line.trim())
                                        .filter(line => line && !line.startsWith('#'));
      
      // Apply protocol filter
      if (protocols && protocols.length > 0 && !(protocols.length === 1 && protocols[0] === 'all')) {
          const types = protocols.map(t => t.trim().toLowerCase());
          currentLines = currentLines.filter(line => types.some(t => line.toLowerCase().startsWith(`${t}://`)));
      }

      // Apply Cloudflare filter
      let cloudflareConfigs = [];
      if (cloudflareOnly) {
          cloudflareConfigs = js_identifyCloudflareDomains(currentLines);
          currentLines = cloudflareConfigs; // If cloudflareOnly is true, only keep CF configs
      }

      js_shuffleArray(currentLines); // Shuffle lines

      // Apply count limit
      if (count !== 0 && currentLines.length > count) {
          currentLines = currentLines.slice(0, count);
      }
      processedContent = currentLines.join('\r\n');
  }

  // Apply desired output format
  if (outputFormat === 'base64') {
    processedContent = js_encodeBase64(processedContent);
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

  return new Response(processedContent, { headers: finalHeaders });
}
