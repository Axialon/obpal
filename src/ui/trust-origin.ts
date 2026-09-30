import { communityMarker } from '../../packages/host/src/origin'

/** Public pages keep the origin disclosure outside their rerendered app root. */
export function mountOriginMarker() {
  if (document.querySelector('body > .community-build')) return
  const marker = communityMarker(location.origin)
  if (marker) document.body.append(marker)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountOriginMarker, { once: true })
else mountOriginMarker()
