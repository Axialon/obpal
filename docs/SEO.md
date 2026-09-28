# Search and agent discovery

The build generates `/robots.txt`, `/sitemap.xml`, and a separate HTML page for each device sim. Change the three crawler signals together in `scripts/lib/seo.mjs` (`AI_SIGNALS`). Public pages have canonical URLs and JSON-LD. The phone controller at `/p/` and the generic device route are noindexed. The older `/sim/device/?d=<id>` address still works and serves the matching canonical page without changing the visitor's URL.

## After deployment

1. Check the live [sitemap](https://obpal.blackboxes.net/sitemap.xml), [robots rules](https://obpal.blackboxes.net/robots.txt), and a clean sim page. Confirm the sim has its own title, description and canonical URL.
2. Submit `https://obpal.blackboxes.net/sitemap.xml` in Google Search Console. The `blackboxes.net` domain property covers this subdomain. Submit the same sitemap in Bing Webmaster Tools.
3. Check Cloudflare's AI crawler and bot settings for this hostname. They must allow the crawlers the owner wants to reach the site; `robots.txt` cannot override a Cloudflare block.
4. After a deploy, run `pnpm run indexnow -- --since <previous-deployed-commit>` to notify IndexNow of changed indexable URLs. Use `--dry-run` first to inspect the list, or pass specific paths such as `/sim/rover/`. The script checks that its public root key file is live before sending. The [IndexNow specification](https://www.indexnow.org/documentation) describes the key file and batch submission.

Check Search Console and Bing reports over time for discovery, canonical selection and indexing errors. A submitted sitemap or IndexNow notification requests crawling; neither guarantees inclusion or ranking. The agent entry points are `/llms.txt`, `/llms-full.txt`, `/catalogue.json`, and the visible HTML content.
