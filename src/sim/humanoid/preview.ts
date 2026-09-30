/** An explicit soft-model opt-in lasts only for this browser session. */
export function softPreview(search: string, storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => sessionStorage) {
  const requested = new URLSearchParams(search).get('preview') === 'soft'
  try {
    const session = storage()
    if (requested) session.setItem('obpal.humanoid.preview', 'soft')
    return requested || session.getItem('obpal.humanoid.preview') === 'soft'
  } catch {
    return requested
  }
}
