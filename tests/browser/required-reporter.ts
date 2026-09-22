import fs from 'node:fs'
import path from 'node:path'
import type { Reporter, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter'

export default class RequiredReporter implements Reporter {
  required = JSON.parse(fs.readFileSync(path.resolve('tests/browser/required-scenarios.json'), 'utf8')).required
  discovered: string[] = []
  results: object[] = []
  issues: string[] = []
  onBegin(_config, suite: Suite) {
    this.discovered = suite.allTests().map(t => t.title.split(' ')[0])
    for (const { id } of this.required) if (this.discovered.filter(x => x === id).length !== 1) this.issues.push(`missing/duplicate required: ${id}`)
    for (const id of this.discovered) if (!this.required.some(r => r.id === id)) this.issues.push(`unregistered scenario: ${id}`)
  }
  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({ id: test.title.split(' ')[0], title: test.title, status: result.status,
      expectedStatus: test.expectedStatus, duration: result.duration,
      errors: result.errors.map(e => e.message),
      attachments: result.attachments.map(a => ({ name: a.name, path: a.path, contentType: a.contentType,
        ...(a.name === 'synthetic-scenario-evidence' && a.body ? { data: JSON.parse(a.body.toString()) } : {}) })) })
    if (result.status !== 'passed' || test.expectedStatus !== 'passed') this.issues.push(`${test.title}: ${result.status}/${test.expectedStatus}`)
  }
  onError(error) { this.issues.push(error.message ?? String(error)) }
  async onEnd(result: FullResult) {
    for (const { id } of this.required) if (this.results.filter((r: any) => r.id === id && r.status === 'passed').length !== 1) this.issues.push(`required scenario did not execute and pass exactly once: ${id}`)
    const status = result.status === 'passed' && this.issues.length === 0 ? 'passed' : 'failed'
    fs.writeFileSync(path.join(process.env.A34C_RUN_DIR!, 'scenarios.json'), JSON.stringify({ status,
      required: this.required.length, discovered: this.discovered, results: this.results, issues: this.issues }, null, 2))
    return { status: status as 'passed' | 'failed' }
  }
}
