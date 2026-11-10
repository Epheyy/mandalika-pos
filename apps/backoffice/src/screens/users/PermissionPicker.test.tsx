import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionPicker } from './PermissionPicker'

describe('PermissionPicker', () => {
  it('no longer offers manage_users (Pengguna is admin-only), but still offers other permissions', () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<PermissionPicker selected={[]} onToggle={() => {}} compact={compact} />)
      expect(html).not.toContain('Kelola Pengguna')
      expect(html).toContain('Kelola Outlet')
    }
  })
})
