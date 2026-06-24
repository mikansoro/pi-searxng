# SearxNG extension for pi

Adds two LLM-callable tools backed by your self-hosted SearxNG instance:

| Tool         | What it does                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| `web_search` | Queries SearxNG JSON API, returns ranked results (title, URL, snippet, engine, date). |
| `web_fetch`  | Fetches any http(s) URL and returns readable plain text (HTML stripped).              |

Also adds the `/searxng` command to inspect the current configuration.

## Setup

1. Make sure your SearxNG instance has the JSON output format enabled. In its
   `settings.yml`:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

   Restart SearxNG after editing.

2. Point the extension at the instance. Either:

   **Env var** (recommended for one-off use):

   ```bash
   export SEARXNG_URL="http://searx.lan:8080"
   # optional
   export SEARXNG_API_KEY="..."
   export SEARXNG_USER_AGENT="my-pi-bot/1.0"
   ```

   **Config file** (recommended for daily use) at `~/.pi/agent/searxng.json`:

   ```json
   {
     "baseUrl": "http://searx.lan:8080",
     "apiKey": null,
     "defaultLanguage": "en",
     "defaultCategories": "general",
     "timeoutMs": 15000,
     "maxFetchChars": 60000
   }
   ```

   Env vars override the file.

3. Reload pi (or restart):

   ```text
   /reload
   ```

4. Verify configuration:

   ```text
   /searxng
   ```

## Usage

The model will pick these tools up automatically once active. Sample prompts:

- *"Search the web for the latest pi-coding-agent release notes."*
- *"Fetch https://example.com/blog/post and summarize it."*

You can also restrict tools explicitly:

```bash
pi --tools read,write,edit,bash,web_search,web_fetch
```

## Notes & limits

- `web_fetch` follows redirects, only allows `http`/`https`, strips
  `<script>`, `<style>`, `<svg>`, etc., decodes common HTML entities, and
  truncates output to `max_chars` (default 60 000).
- For JSON or plain-text responses, the body is returned as-is.
- Pass `raw: true` to `web_fetch` to skip HTML-to-text conversion.
- Both tools honor pi's abort signal (Escape cancels in-flight requests).
- No third-party dependencies; uses Node's built-in `fetch`.
