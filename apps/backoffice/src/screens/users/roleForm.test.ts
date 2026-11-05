import { describe, expect, it } from 'vitest'
import { roleFormProblem } from './roles'

describe('roleFormProblem', () => {
  it('requires a name', () => {
    expect(roleFormProblem({ name: '  ', permissions: ['orders.read'] })).toBe('Nama role wajib diisi.')
  })
  it('requires at least one permission', () => {
    expect(roleFormProblem({ name: 'Kasir', permissions: [] })).toBe('Pilih minimal 1 izin')
  })
  it('passes a named role with a permission', () => {
    expect(roleFormProblem({ name: 'Kasir', permissions: ['orders.read'] })).toBeNull()
  })
})
