# Putting ob.Pal Link on the Chrome Web Store

The steps in the Developer Dashboard, in order. What to paste is in [listing.md](listing.md); the images are in this folder.

## Before you start

- **The first-upload zip:** `%USERPROFILE%\.obpal-keys\store\obpal-link-<version>-store-first-upload.zip`. It carries the extension's private key as `key.pem`, so the store keeps Link's ID, the one ob.Pal Desktop talks to. It's made outside the repository, next to the key, by:

  ```sh
  pnpm run store:extension -- --with-key
  ```

  (`--with-key` alone uses `%USERPROFILE%\.obpal-keys\extension-key.pem`; a path after it uses that key.) Run it again if the version changes before you upload. It prints `extension ID check: match` when the key is right, and writes nothing otherwise.
- **The account page** (once): verify the contact email, set the publisher name, and answer the trader question (see the decisions below).

## Steps

1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and click **New item**.
2. Upload the first-upload zip from `.obpal-keys\store`.
3. **Package:** check that the item's ID is `jnnpcnoilofjaffabnhecfokjjknlemg`. If it's anything else, don't submit: the ID is fixed by the first upload, so start a new item with the right zip.
4. **Store listing:** from listing.md, paste the description, and pick the category and the language. Then upload the images:
   - `icon-128.png` as the store icon;
   - `screenshot-1.png` … `screenshot-5.png`, in that order;
   - `tile-440x280.png` as the small promo tile;
   - `marquee-1400x560.png` as the marquee.

   Then fill in the homepage and support URLs, and answer No to mature content. The name and summary come from the package.
5. **Privacy practices:** from listing.md, paste the following:
   - the single purpose;
   - the justification for each permission;
   - the remote code answer (No), with its text.

   Under data usage, tick none of the data types and all three certifications. Then paste the privacy policy URL.
6. **Distribution:** Public, and the regions you choose.
7. **Test instructions:** paste the reviewer notes from listing.md.
8. **Submit for review.** Reviews take from a few days to a few weeks. Choose to publish by hand after approval if you'd like the site to link to the listing the same day.

## After approval

- **Delete the first-upload zip** (`%USERPROFILE%\.obpal-keys\store\`): the store has the key now. Keep `extension-key.pem` itself, as safely as before.
- **Later updates:** raise the version, run `pnpm run store:extension`, and upload `extension\release\obpal-link-<version>-store.zip` with **Package → Upload new package**. It has no key and doesn't need one.
- **The GitHub release keeps working** for developer-mode installs: its manifest keeps the public key, so it has the same ID and ob.Pal Desktop allows it. Because the IDs match, anyone who loaded the GitHub copy should remove it before installing from the store.
- **Send Claude the listing's address**, so the site's Link page and the README can link to it.

## Decisions for you

- **Category:** Tools is suggested. Games is the alternative, though the store means games themselves by it.
- **Regions:** all regions is suggested. Nothing in Link depends on the country.
- **Trader or non-trader** (EU Digital Services Act, on the account page): a trader's legal name, address and phone number are shown to EU visitors. This depends on whether you publish as a business.
- **Official URL** (optional): the listing shows a verified publisher only after the site is verified in Google Search Console with the same Google account.
- **Data usage:** listing.md ticks none of the data types, because nothing reaches the developer. The judgement call is typing and input, which go through the extension, but only to your own PC and only in memory. The most cautious reading would tick "User activity" as well. That would tell visitors that the developer collects their activity, which isn't so, so it isn't suggested.
- **Publisher name** and the contact email shown on the listing.

Docs used: [images](https://developer.chrome.com/docs/webstore/images), [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [publish](https://developer.chrome.com/docs/webstore/publish), [review](https://developer.chrome.com/docs/webstore/review-process), [trader](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure). The key.pem first upload isn't on developer.chrome.com today: it comes from Chrome's original packaging guide and the [Chromium extensions group](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms).
