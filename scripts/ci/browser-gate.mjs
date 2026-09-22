// Canonical fail-closed browser gate. No app env loading or deployed URL input.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const cli = require.resolve('@playwright/test/cli')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Only --output <new-directory> is supported')
const output = path.resolve(args[1] ?? path.join(root, 'artifacts/browser', `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`))
if (fs.existsSync(output)) throw new Error('Use a new evidence directory; never overwrite a previous run')
fs.mkdirSync(output, { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|CI|PLAYWRIGHT_BROWSERS_PATH)$/i.test(k)))
env.A34C_RUN_DIR = output
const ports = [5183, 5184]
const report = { status: 'running', root, output, phases: [], cleanup: {}, network: {}, registry: 'tests/browser/required-scenarios.json' }
const write = () => fs.writeFileSync(path.join(output, 'gate.json'), JSON.stringify(report, null, 2))
const listening = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port })
  let done = false
  const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value) } }
  socket.setTimeout(500, () => finish(false))
  socket.on('connect', () => finish(true)); socket.on('error', () => finish(false))
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
let child, interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true
  void terminate(child)
})
async function terminate(p) {
  if (!p?.pid || !alive(p.pid)) return
  if (process.platform === 'win32') await new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', reject); killer.once('exit', resolve)
  })
  else {
    try { process.kill(-p.pid, 'SIGTERM') } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
    // A timed-out child must not hold the gate open indefinitely.
    try { process.kill(-p.pid, 'SIGKILL') } catch {}
  }
}
async function run(phase, extra) {
  if (interrupted) throw new Error('Browser gate interrupted')
  const command = [process.execPath, cli, 'test', '-c', 'tests/browser/playwright.config.ts', ...extra]
  const log = fs.openSync(path.join(output, `${phase}.log`), 'w')
  const started = Date.now()
  child = spawn(command[0], command.slice(1), { cwd: root, env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', log, log] })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void terminate(child) }, 960_000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    report.phases.push({ phase, command, cwd: root, exit: code, timedOut, milliseconds: Date.now() - started })
    if (code !== 0 || timedOut || interrupted) throw new Error(`${phase} failed (exit=${code}, timeout=${timedOut})`)
  } finally { clearTimeout(timer); fs.closeSync(log); child = undefined; write() }
}
const jsonLines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
try {
  write()
  for (const port of ports) if (await listening(port)) throw new Error(`Strict fixture port already occupied: ${port}`)
  await run('discovery', ['--list', '--reporter=json'])
  const discovery = JSON.parse(fs.readFileSync(path.join(output, 'discovery.log'), 'utf8'))
  const titles = []
  const walk = suite => { for (const spec of suite.specs ?? []) titles.push(spec.title.split(' ')[0]); for (const nested of suite.suites ?? []) walk(nested) }
  for (const suite of discovery.suites) walk(suite)
  const registry = JSON.parse(fs.readFileSync(path.join(root, report.registry), 'utf8')).required
  report.discovery = { expected: registry.map(r => r.id), actual: titles }
  if (registry.length === 0 || new Set(registry.map(r => r.id)).size !== registry.length) throw new Error('Invalid empty/duplicate scenario registry')
  if (JSON.stringify([...titles].sort()) !== JSON.stringify(registry.map(r => r.id).sort())) throw new Error('Required scenario missing, duplicate or unregistered at discovery')
  await run('execution', [])
  const scenarios = JSON.parse(fs.readFileSync(path.join(output, 'scenarios.json'), 'utf8'))
  if (scenarios.status !== 'passed' || scenarios.results.length !== registry.length) throw new Error('Required scenarios did not all execute and pass')
  report.scenarios = { passed: scenarios.results.length, skipped: 0 }
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error) }
finally {
  await terminate(child)
  const processes = jsonLines(path.join(output, 'processes.jsonl'))
  // Allow bounded exit propagation after Playwright managed webServer/worker cleanup.
  const pids = [...new Set(processes.map(p => p.pid))]
  for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 100))
  const live = pids.filter(alive), open = []
  for (const port of ports) if (await listening(port)) open.push(port)
  report.cleanup = { processes, liveOwnedPids: live, openPorts: open, status: live.length || open.length ? 'uncertain' : 'confirmed' }
  const network = jsonLines(path.join(output, 'network.jsonl'))
  report.network = { scenarios: network.length, blocked: network.flatMap(n => n.blocked) }
  if (live.length || open.length || report.network.blocked.length) report.status = 'failed'
  write()
}
console.log(`Browser gate ${report.status}; evidence: ${output}`)
process.exitCode = report.status === 'passed' ? 0 : 1
