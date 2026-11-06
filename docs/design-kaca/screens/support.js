// Minimal stand-in for the design tool's support.js, rebuilt 2026-11-06 so these .dc.html mocks render with
// their sample data in a plain browser (the original runtime was never part of the spec export).
// Supports what the 19 mocks use: <x-dc> root, <helmet> head content, {{expr}} in text and attributes,
// <sc-for list as>, <sc-if value>, on*/ref bindings, and a `class Component extends DCLogic` with props
// (defaults from data-props), state, setState, renderVals(), componentDidMount/WillUnmount.
// Temporary like the rest of docs/design-kaca (deleted by slice Z).
(function () {
  'use strict'

  class DCLogic {
    constructor(props) { this.props = props; this.state = {} }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch
      this.state = Object.assign({}, this.state, next)
      if (this.__render) this.__render()
    }
  }
  window.DCLogic = DCLogic

  const evalCache = new Map()
  function evaluate(expr, scope) {
    let fn = evalCache.get(expr)
    if (!fn) {
      // eslint-disable-next-line no-new-func
      fn = new Function('__s', 'with (__s) { return (' + expr + ') }')
      evalCache.set(expr, fn)
    }
    try { return fn(scope) } catch (err) { console.warn('[dc] expression failed:', expr, err.message); return undefined }
  }

  const WHOLE = /^\s*\{\{([\s\S]+?)\}\}\s*$/
  const PART = /\{\{([\s\S]+?)\}\}/g
  const interpolate = (text, scope) => text.replace(PART, (_, e) => {
    const v = evaluate(e, scope)
    return v === undefined || v === null || v === false ? '' : String(v)
  })
  const BOOLEAN_ATTRS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readonly', 'required', 'open', 'multiple'])

  function renderNode(src, scope, out) {
    if (src.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(src.nodeValue.includes('{{') ? interpolate(src.nodeValue, scope) : src.nodeValue))
      return
    }
    if (src.nodeType !== Node.ELEMENT_NODE) return
    const tag = src.tagName.toLowerCase()
    if (tag === 'sc-for') {
      const m = WHOLE.exec(src.getAttribute('list') || '')
      const list = m ? evaluate(m[1], scope) : []
      const as = src.getAttribute('as') || 'item'
      ;(Array.isArray(list) ? list : []).forEach((item, index) => {
        const child = Object.create(scope); child[as] = item; child.$index = index
        src.childNodes.forEach((n) => renderNode(n, child, out))
      })
      return
    }
    if (tag === 'sc-if') {
      const m = WHOLE.exec(src.getAttribute('value') || '')
      if (m && evaluate(m[1], scope)) src.childNodes.forEach((n) => renderNode(n, scope, out))
      return
    }
    const el = src.namespaceURI === 'http://www.w3.org/2000/svg'
      ? document.createElementNS(src.namespaceURI, src.tagName)
      : document.createElement(src.tagName)
    for (const { name, value } of Array.from(src.attributes)) {
      if (name.startsWith('hint-')) continue
      const whole = WHOLE.exec(value)
      if (name === 'ref') { if (whole) { const f = evaluate(whole[1], scope); if (typeof f === 'function') queueMicrotask(() => f(el)) } continue }
      if (name.startsWith('on') && whole) {
        const f = evaluate(whole[1], scope)
        if (typeof f === 'function') el.addEventListener(name.slice(2).toLowerCase(), f)
        continue
      }
      if (whole) {
        const v = evaluate(whole[1], scope)
        if (BOOLEAN_ATTRS.has(name)) { if (v && v !== 'false') el.setAttribute(name, ''); continue }
        if (name === 'value' && 'value' in el) { el.value = v == null ? '' : v; el.setAttribute(name, v == null ? '' : v); continue }
        if (v === undefined || v === null || v === false) continue
        el.setAttribute(name, v === true ? '' : String(v))
        continue
      }
      el.setAttribute(name, value.includes('{{') ? interpolate(value, scope) : value)
    }
    const kids = src.tagName.toLowerCase() === 'template' ? src.content.childNodes : src.childNodes
    kids.forEach((n) => renderNode(n, scope, el))
    out.appendChild(el)
  }

  function boot() {
    const root = document.querySelector('x-dc')
    if (!root) return
    const helmet = root.querySelector('helmet')
    if (helmet) { Array.from(helmet.childNodes).forEach((n) => document.head.appendChild(n)); helmet.remove() }
    const script = document.querySelector('script[data-dc-script]')
    const propSpec = script ? JSON.parse(script.getAttribute('data-props') || '{}') : {}
    const props = {}
    for (const [k, spec] of Object.entries(propSpec)) if (!k.startsWith('$')) props[k] = spec && 'default' in spec ? spec.default : undefined
    const preview = propSpec.$preview
    // Keep the raw template, then mount into a fresh host.
    const tpl = document.createElement('template')
    tpl.innerHTML = root.innerHTML
    const host = document.createElement('div')
    host.id = 'dc-host'
    root.replaceWith(host)
    let instance = { renderVals: () => ({}) }
    if (script) {
      // eslint-disable-next-line no-new-func
      const Component = new Function('DCLogic', script.textContent + '\n;return Component')(DCLogic)
      instance = new Component(props)
    }
    const render = () => {
      const vals = instance.renderVals() || {}
      const scope = Object.assign(Object.create(null), vals)
      const frag = document.createDocumentFragment()
      tpl.content.childNodes.forEach((n) => renderNode(n, scope, frag))
      host.replaceChildren(frag)
    }
    instance.__render = render
    render()
    if (typeof instance.componentDidMount === 'function') instance.componentDidMount()
    window.__dc = { instance, props, preview }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
