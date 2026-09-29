/**
 * The host side every sim shares (CATALOGUE §5–7): a shared scene with an invite, participants in their colours,
 * one claim per node, approval before a first claim where the system asks for it, and a record of who held what.
 * Each sim supplies its nodes and what their input does.
 */
import { CONTROLLERS, layoutControllers, type SceneNode } from '@obpal/core'
import { Claims, PairingChip, PartFocus, Remote, type Layout, type Participant } from '@obpal/host'
import { family } from '../family'
import { ICONS } from '../ui/icons'
import { holdForPhone } from '../ui/recover'
import { ControlSession } from './control-space'
import { quickAction } from '../ui/quick-actions'

export interface SimScene {
  remote: Remote
  control: ControlSession
  claims: Claims
  /** What each participant's trackpad drives within the node it holds (PROTOCOL §3a): a part, a set, or all of it. */
  focus: PartFocus
  nodes: SceneNode[]
  /** Whether a participant may claim (approved, or approval isn't needed). */
  allowed(id: string): boolean
  /** Whether the screen is letting everyone in without asking. */
  waived(): boolean
  /**
   * Keep approval on while something physical is live: "let everyone in without asking" is switched off, and can't be
   * switched on again until the sim lets go. Called with the current state whenever it may have changed.
   */
  holdApproval(held: boolean): void
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
  /** Change what the scene offers (an arm added, removed or reconfigured). Claims on nodes that went are let go. */
  setNodes(nodes: SceneNode[]): void
  /** A node's name as people read it (with its group, where the sim asks for that). */
  nodeName(id: string): string
}

export interface SimOptions {
  appName: string
  layout: Layout
  nodes: SceneNode[]
  /** Physical systems: the screen lets each participant in before its first claim (CATALOGUE §7). */
  approval: boolean
  /** A hint for whoever just took a node (how to drive it). */
  howTo?(node: string): string
  /** How to name a node in toasts, the record and the phone's chip (default: its name). */
  label?(node: SceneNode): string
  /** Called after any change of who holds what. */
  changed?(): void
  /** A participant chose another part or set of what it holds, or locked a part. */
  focused?(who: string): void
  joined?(p: Participant): void
  left?(p: Participant): void
}

const $ = (id: string) => document.getElementById(id)!
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '•'
const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

export async function startSimScene(o: SimOptions): Promise<SimScene> {
  const remote = await Remote.create({ appName: o.appName, layout: o.layout, seats: 8 })
  holdForPhone(remote)
  const query = new URLSearchParams(location.search)
  const control = new ControlSession(remote, query.get('d') ?? (location.pathname.includes('/arm/') ? `arm-${query.get('kind') ?? 'arm5'}` : 'arena'))
  const claims = new Claims()
  const approved = new Set<string>()
  const pending = new Set<string>()
  const people = new Map<string, Participant>()
  let nodes = o.nodes
  const nodeName = (id: string) => { const n = nodes.find((x) => x.id === id); return n ? o.label?.(n) ?? n.name : id }
  const focus = new PartFocus(remote, (who) => { const id = claims.held(who); return id ? nodes.find((n) => n.id === id) : undefined }, (who) => o.focused?.(who))
  remote.setHostPerson({ name: 'Screen', color: family.accentColor() })
  // The pairing chip: open while nobody is here, closed by itself as a phone comes in; the people chip's + opens it.
  // Its card never covers the panel (the e-stop), the people list, the stop banner, the menus, a camera's picture (the
  // device sims) or the open quick-actions tray: it folds while one is in the way.
  const chip = new PairingChip({
    remote, open: true, testLink: true, avoid: '.sim-window, #people, .stopped-banner, #switcher, #themes, .quick-panel',
    onToggle: (open) => $('chip-invite').setAttribute('aria-pressed', String(open)),
  })
  addEventListener('obpal:viewmode', e => { if ((e as CustomEvent<string>).detail !== 'overview') chip.collapse() })
  Object.assign(window, { __obpal: remote, __sim: { claims, approved, chip, control, allowed: (id: string) => allowed(id) } })

  const autoAllow = $('auto-allow') as HTMLInputElement | null
  let approvalHeld = false
  const waived = () => !!autoAllow?.checked && !approvalHeld
  const allowed = (id: string) => !o.approval || approved.has(id) || waived()
  const holdApproval = (held: boolean) => {
    if (held === approvalHeld) return
    approvalHeld = held
    if (!autoAllow) return
    autoAllow.disabled = held
    autoAllow.parentElement!.title = held ? 'Approval stays on while a real arm is live' : ''
    if (held && autoAllow.checked) {
      autoAllow.checked = false
      note('Everyone is asked again: a real arm is live')
      renderPeople()
    }
  }

  let noteTimer: ReturnType<typeof setTimeout> | undefined
  const note = (text: string) => {
    const n = $('note')
    n.textContent = text
    n.classList.add('in')
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => n.classList.remove('in'), 2600)
  }
  const controllers = layoutControllers(o.layout)
  if (controllers.length > 1) quickAction({
    id: 'switch', group: 'page', label: 'Switch controller', icon: 'phone',
    hint: 'Cycle the lead phone’s controller',
    run: () => {
      const lead = remote.participants.find(p => p.lead)
      if (!lead) { chip.expand(); return }
      const at = controllers.findIndex(c => c === lead.controller)
      const next = controllers[(at + 1) % controllers.length]
      remote.setLayout({ ...o.layout, controllers: [next], modes: [...CONTROLLERS[next].modes] }, lead.id)
      note(`${lead.name}: ${CONTROLLERS[next].name}`)
    },
  })
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
    remote.setScene({ held: claims.snapshot(), ...(nodesSent ? {} : { nodes }) })
    nodesSent = true
    renderPeople()
    o.changed?.()
  }

  const take = (node: string, who: string, force = false): boolean => {
    const r = claims.take(node, who, force)
    const name = nodeName(node)
    if (!r.ok) {
      remote.feedback({ haptic: 'bump', toast: `${nameOf(r.holder)} has ${nodeName(r.blocking ?? node)}` }, who)
      return false
    }
    for (const lost of [...(r.lost ? [r.lost] : []), ...(r.evicted ?? [])]) {
      remote.feedback({ haptic: 'bump', toast: `The screen took ${name}` }, lost)
      remote.setValues({ part: '' }, lost)
      focus.reset(lost)
      log(`The screen took ${name} from ${nameOf(lost)}`, colorOf('host'))
    }
    // What the trackpad drove belonged to what `who` held before: it starts on the whole of the new node.
    focus.reset(who)
    if (!r.lost && !r.evicted) log(`${nameOf(who)} took ${name}${r.released ? `, letting go of ${nodeName(r.released)}` : ''}`, colorOf(who))
    if (who !== 'host') {
      remote.feedback({ haptic: 'tick', toast: o.howTo?.(node) ?? `You have ${name}` }, who)
      remote.setValues({ part: name, partLive: false, partValue: '' }, who)
      control.position(who)
    }
    publish()
    return true
  }
  const release = (who: string) => {
    const node = claims.release(who)
    if (!node) return
    log(`${nameOf(who)} let go of ${nodeName(node)}`, colorOf(who))
    if (who !== 'host') { remote.setValues({ part: '' }, who); focus.reset(who) }
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

  remote.on('connect', () => { $('chip').hidden = false })
  remote.on('disconnect', () => { $('chip').hidden = true; chip.expand(); $('people').hidden = true })
  remote.on('join', (p) => {
    people.set(p.id, p)
    log(`${p.name} joined`, p.color)
    if (o.approval && !allowed(p.id)) {
      pending.add(p.id)
      note(`${p.name} wants to take part: let them in from People`)
      $('people').hidden = false
      remote.feedback({ toast: 'Waiting for the screen to let you in' }, p.id)
    }
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
    if (!nodes.some((n) => n.id === node)) { remote.feedback({ haptic: 'bump', toast: 'That’s not in this scene' }, who.id); return }
    take(node, who.id)
  })
  autoAllow?.addEventListener('change', () => {
    if (approvalHeld) autoAllow.checked = false
    else if (autoAllow.checked) { for (const id of pending) approved.add(id); pending.clear() }
    renderPeople()
  })
  $('chip-disc').onclick = () => remote.disconnect()
  $('chip-invite').onclick = () => { chip.toggle(); if (chip.expanded) $('people').hidden = true }
  $('chip-who').onclick = () => { const p = $('people'); p.hidden = !p.hidden; if (!p.hidden) chip.collapse() }
  $('invite-new').onclick = async () => { await remote.resetInvite(); note('New invite link: the old code no longer works') }
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon!] ?? ''))

  const setNodes = (next: SceneNode[]) => {
    for (const n of nodes) {
      if (next.some((x) => x.id === n.id)) continue
      const who = claims.free(n.id)
      if (who && who !== 'host') {
        remote.feedback({ haptic: 'bump', toast: `${nodeName(n.id)} left the scene` }, who)
        remote.setValues({ part: '' }, who)
        focus.reset(who)
        log(`${nodeName(n.id)} left the scene: ${nameOf(who)} let go`, colorOf(who))
      }
    }
    nodes = next
    result.nodes = next
    nodesSent = false
    publish()
  }

  const result: SimScene = { remote, control, claims, focus, nodes, allowed, waived, holdApproval, nameOf, colorOf, log, note, publish, take, release, setNodes, nodeName }
  publish()
  return result
}
