// Shared upload proxy config — same for the entire app instance.
// If you ever redeploy the proxy to a different URL, change these two values.
//
// Note: UPLOAD_SECRET is bundled in the SPA JavaScript. That's intentional —
// its purpose is to keep random internet scrapers from hammering the proxy,
// not to protect Bunny credentials (those come per-user from Settings).

export const PROXY_URL = 'https://grevo-records-api.bunny.run';
export const UPLOAD_SECRET =
  '670a4bd415fa789b87dc095e09b4a7aafdf2b34ee819ab7295a60811bdce231d';
