import type { components } from './schema'

export type Schemas = components['schemas']
export type User = Schemas['User']
export type Product = Schemas['Product']
export type ProductListResponse = Schemas['ProductListResponse']
export type AuthData = Schemas['AuthData']

export interface ClientOptions {
  baseUrl: string
  /** Returns the current access token, or null when unauthenticated. */
  getToken: () => string | null
  /** Active outlet id sent as X-Outlet-Id (null = use token's outlet). */
  getOutletId?: () => string | null
  /** Invoked on a 401 so the app can clear auth / redirect to login. */
  onUnauthorized?: () => void
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Api {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>
  login: (email: string, password: string) => Promise<AuthData>
  refresh: (refresh: string) => Promise<AuthData>
  logout: (refresh: string) => Promise<void>
  me: () => Promise<User>
  listProducts: (page?: number, limit?: number) => Promise<ProductListResponse>
}

export function createClient(opts: ClientOptions): Api {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = opts.getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const outlet = opts.getOutletId?.()
    if (outlet) headers['X-Outlet-Id'] = outlet

    const res = await fetch(opts.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401) {
      opts.onUnauthorized?.()
      throw new ApiError(401, 'unauthorized')
    }
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) {
      throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
    }
    return json as T
  }

  return {
    request,
    async login(email, password) {
      const r = await request<{ data: AuthData }>('POST', '/api/v1/auth/login', {
        email,
        password,
      })
      return r.data
    },
    async refresh(refresh) {
      const r = await request<{ data: AuthData }>('POST', '/api/v1/auth/refresh', {
        refresh,
      })
      return r.data
    },
    async logout(refresh) {
      await request<unknown>('POST', '/api/v1/auth/logout', { refresh })
    },
    async me() {
      const r = await request<{ data: User }>('GET', '/api/v1/auth/me')
      return r.data
    },
    async listProducts(page = 1, limit = 50) {
      return request<ProductListResponse>(
        'GET',
        `/api/v1/products?page=${page}&limit=${limit}`,
      )
    },
  }
}
