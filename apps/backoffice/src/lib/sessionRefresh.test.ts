import { describe, expect, it, vi } from 'vitest'
import type { AuthData, User } from '@mandalika/api'
import { applyRefreshedSession } from './sessionRefresh'

type Store = Parameters<typeof applyRefreshedSession>[1]['store']

function user(role: string, permissions: string[] = []): User {
  return { id: 'u1', email: 'a@b.c', displayName: 'A', role, permissions } as unknown as User
}

function setup(over: Partial<Store> = {}) {
  const store: Store = {
    access: 'old-access',
    refresh: 'old-refresh',
    outletId: 'outlet-x',
    userId: 'u1',
    onUnauthorized: null,
    onTokens: null,
    ...over,
  }
  const deps = { store, persist: vi.fn(), setUser: vi.fn(), clear: vi.fn() }
  return { store, deps }
}

const data = (u: User): AuthData => ({ access: 'new-access', refresh: 'new-refresh', user: u }) as AuthData

describe('applyRefreshedSession', () => {
  it('keeps the session and replaces the user’s permissions', () => {
    const { store, deps } = setup()
    const u = user('manager', ['view_reports'])
    expect(applyRefreshedSession(data(u), deps)).toBe('kept')
    expect(store.access).toBe('new-access')
    expect(store.refresh).toBe('new-refresh')
    expect(store.userId).toBe('u1')
    expect(deps.persist).toHaveBeenCalledWith('new-refresh')
    expect(deps.setUser).toHaveBeenCalledWith(u)
    expect(deps.clear).not.toHaveBeenCalled()
  })

  it('a demotion to cashier signs out and persists nothing', () => {
    const { store, deps } = setup()
    expect(applyRefreshedSession(data(user('cashier')), deps)).toBe('signed-out')
    expect(deps.clear).toHaveBeenCalledTimes(1)
    expect(deps.persist).not.toHaveBeenCalled()
    expect(deps.setUser).not.toHaveBeenCalled()
    expect(store.access).toBe('old-access')
  })

  it('an admin demoted to manager drops the outlet override before the retry', () => {
    const { store, deps } = setup()
    expect(applyRefreshedSession(data(user('manager')), deps)).toBe('kept')
    expect(store.outletId).toBeNull()
  })

  it('an admin who stays admin keeps the outlet override', () => {
    const { store, deps } = setup()
    expect(applyRefreshedSession(data(user('admin')), deps)).toBe('kept')
    expect(store.outletId).toBe('outlet-x')
  })

  it('a refresh landing after logout is ignored', () => {
    const { store, deps } = setup({ refresh: null, access: null })
    expect(applyRefreshedSession(data(user('manager')), deps)).toBe('ignored')
    expect(store.access).toBeNull()
    expect(deps.persist).not.toHaveBeenCalled()
    expect(deps.setUser).not.toHaveBeenCalled()
    expect(deps.clear).not.toHaveBeenCalled()
  })
})
