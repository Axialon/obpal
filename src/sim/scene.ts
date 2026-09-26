/**
 * The host side every sim shares (CATALOGUE §5–7): a shared scene with an invite, participants in their colours,
 * one claim per node, approval before a first claim where the system asks for it, and a record of who held what.
 * Each sim supplies its nodes and what their input does.
 */
import type { SceneNode } from '@obpal/core'
import { Claims, Remote, type Layout, type Participant } from '@obpal/host'
import { family } from '../family'
import { ICONS } from '../ui/icons'

export interface SimScene {
  remote: Remote
  claims: Claims
  nodes: SceneNode[]
  /** Whether a participant may claim (approved, or approval isn't needed). */
  allowed(id: string): boolean
  nameOf(id: string | undefined): string
  colorOf(id: string | undefined): string
  /** Add a line to the record (who held which node, and when). */
  log(text: string, color?: string): void
  /** A short message on the screen. */
  note(text: string): void
  /** Publish who holds what to every device, and redraw the people list. */
  publish(): void
  /** Take a node for someone (the screen can force), with the same feedback as a device's own claim. */
  take(node: string, who: string, force?: boolean): boolean
  /** Let go of what someone holds. */
  release(who: string): void
}

export interface SimOptions {
  appName: string
  layout: Layout
  nodes: SceneNode[]
  /** Physical systems: the screen lets each participant in before its first claim (CATALOGUE §7). */
  approval: boolean
  /** A hint for whoever just took a node (how to drive it). */
  howTo?(node: string): string
  /** Called after any change of who holds what. */
  changed?(): void
  joined?(p: Participant): void
  left?(p: Participant): void
}

const $ = (id: string) => document.getElementById(id)!
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '•'
const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

export async function startSimScene(o: SimOptions): Promise<SimScene> {
  const remote = await Remote.create({ appName: o.appName, layout: o.layout, seats: 8 })
  const claims = new Claims()
  const approved = new Set<string>()
  const pending = new Set<string>()
  const people = new Map<string, Participant>()
  const nodeName = (id: string) => o.nodes.find((n) => n.id === id)?.name ?? id
  remote.setHostPerson({ name: 'Screen', color: family.accentColor() })
  remote.mountPairing($('pair'), { variant: 'compact' })
  Object.assign(window, { __obpal: remote, __sim: { claims, approved } })

  const autoAllow = $('auto-allow') as HTMLInputElement | null
  const allowed = (id: string) => !o.approval || approved.has(id) || !!autoAllow?.checked

  let noteTimer: ReturnType<typeof setTimeout> | undefined
  const note = (text: string) => {
    const n = $('note')
    n.textContent = text
    n.classList.add('in')
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => n.classList.remove('in'), 2600)
  }
  const nameOf = (id: string | undefined) => (!id ? '' : id === 'host' ? 'The screen' : people.get(id)?.name ?? 'Someone')
  const colorOf = (id: string | undefined) => (!id ? '' : id === 'host' ? family.accentColor() : people.get(id)?.color ?? '')

  const log = (text: string, color?: string) => {
    const list = $('log')
    const li = document.createElement('li')
    li.innerHTML = '<time></time><i></i><span></span>'
    li.querySelector('time')!.textContent = clock()
    if (color) (li.querySelector('i') as HTMLElement).style.background = color
    li.querySelector('span')!.textContent = text
    list.prepend(li)
    while (list.children.length > 80) list.lastElementChild!.remove()
  }

  let nodesSent = false
  const publish = () => {
    remote.setScene({ held: claims.snapshot(), ...(nodesSent ? {} : { nodes: o.nodes }) })
    nodesSent = true
    renderPeople()
    o.changed?.()
  }

  const take = (node: string, who: string, force = false): boolean => {
    const r = claims.take(node, who, force)
    const name = nodeName(node)
    if (!r.ok) {
      remote.feedback({ haptic: 'bump', toast: `${nameOf(r.holder)} has ${name}` }, who)
      return false
    }
    if (r.lost) {
      remote.feedback({ haptic: 'bump', toast: `The screen took ${name}` }, r.lost)
      remote.setValues({ part: '' }, r.lost)
      log(`The screen took ${name} from ${nameOf(r.lost)}`, colorOf('host'))
    } else log(`${nameOf(who)} took ${name}${r.released ? `, letting go of ${nodeName(r.released)}` : ''}`, colorOf(who))
    if (who !== 'host') {
      remote.feedback({ haptic: 'tick', toast: o.howTo?.(node) ?? `You have ${name}` }, who)
      remote.setValues({ part: name, partLive: false, partValue: '' }, who)
    }
    publish()
    return true
  }
  const release = (who: string) => {
    const node = claims.release(who)
    if (!node) return
    log(`${nameOf(who)} let go of ${nodeName(node)}`, colorOf(who))
    if (who !== 'host') remote.setValues({ part: '' }, who)
    publish()
  }

  function renderPeople() {
    const list = [...people.values()]
    $('chip-people').replaceChildren(...list.map((p) => {
      const d = document.createElement('span')
      d.className = 'person'
      d.style.setProperty('--c', p.color)
      d.textContent = initials(p.name)
      return d
    }))
    $('chip-text').textContent = list.length === 1 ? list[0].name : `${list.length} people`
    $('people-list').replaceChildren(...list.map((p) => {
      const li = document.createElement('li')
      const node = claims.held(p.id)
      li.innerHTML = '<span class="person"></span><span class="pp-text"><b></b><small></small></span>'
      const dot = li.querySelector<HTMLElement>('.person')!
      dot.style.setProperty('--c', p.color)
      dot.textContent = initials(p.name)
      li.querySelector('b')!.textContent = p.name
      li.querySelector('small')!.textContent = !allowed(p.id) ? 'Waiting for you to let them in' : node ? `Holding ${nodeName(node)}` : 'Free'
      if (!allowed(p.id)) {
        const ok = document.createElement('button')
        ok.className = 'allow'
        ok.textContent = 'Let in'
        ok.onclick = () => {
          approved.add(p.id)
          pending.delete(p.id)
          log(`Let ${p.name} in`, p.color)
          remote.feedback({ haptic: 'tick', toast: 'You’re in: pick something from the scene list' }, p.id)
          renderPeople()
          // Nobody else waiting: the panel steps aside.
          if (!pending.size) $('people').hidden = true
        }
        li.appendChild(ok)
      }
      const x = document.createElement('button')
      x.className = 'chip-x'
      x.innerHTML = ICONS.close
      x.setAttribute('aria-label', `Remove ${p.name}`)
      x.onclick = () => { remote.disconnect(p.id); note(`Removed ${p.name}`) }
      li.appendChild(x)
      return li
    }))
    $('people').classList.toggle('asking', pending.size > 0)
  }

  const setInvite = (on: boolean) => {
    if (remote.status !== 'connected') return
    $('pair').hidden = !on
    $('pair').dataset.invite = on ? 'open' : ''
    $('chip-invite').setAttribute('aria-pressed', String(on))
    if (on) $('people').hidden = true
  }

  remote.on('connect', () => { $('pair').hidden = true; $('chip').hidden = false })
  remote.on('disconnect', () => { $('chip').hidden = true; $('pair').hidden = false; $('people').hidden = true })
  remote.on('join', (p) => {
    people.set(p.id, p)
    log(`${p.name} joined`, p.color)
    if (o.approval && !allowed(p.id)) {
      pending.add(p.id)
      note(`${p.name} wants to take part: let them in from People`)
      $('people').hidden = false
      remote.feedback({ toast: 'Waiting for the screen to let you in' }, p.id)
    }
    if ($('pair').dataset.invite === 'open') setInvite(false)
    publish()
    o.joined?.(p)
  })
  remote.on('leave', (p) => {
    const node = claims.release(p.id)
    people.delete(p.id)
    pending.delete(p.id)
    approved.delete(p.id)
    log(`${p.name} left${node ? `, letting go of ${nodeName(node)}` : ''}`, p.color)
    publish()
    o.left?.(p)
  })
  remote.on('claim', ({ node }, who) => {
    if (!allowed(who.id)) { remote.feedback({ haptic: 'bump', toast: 'Waiting for the screen to let you in' }, who.id); return }
    if (node === null) { release(who.id); return }
    if (!o.nodes.some((n) => n.id === node)) { remote.feedback({ haptic: 'bump', toast: 'That’s not in this scene' }, who.id); return }
    take(node, who.id)
  })
  autoAllow?.addEventListener('change', () => { if (autoAllow.checked) { for (const id of pending) approved.add(id); pending.clear() } renderPeople() })
  $('chip-disc').onclick = () => remote.disconnect()
  $('chip-invite').onclick = () => setInvite($('pair').dataset.invite !== 'open')
  $('chip-who').onclick = () => { const p = $('people'); p.hidden = !p.hidden; if (!p.hidden) setInvite(false) }
  $('invite-new').onclick = async () => { await remote.resetInvite(); note('New invite link: the old code no longer works') }
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon!] ?? ''))

  publish()
  return { remote, claims, nodes: o.nodes, allowed, nameOf, colorOf, log, note, publish, take, release }
}
