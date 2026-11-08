import { describe, expect, test } from 'claude-code/testing'

import { merge, ordered } from '../hooks/register'

const agent = (id: string, status: 'running' | 'completed', parentId?: string) => ({
  id,
  description: `task ${id}`,
  type: 'Explore',
  status,
  ...(parentId ? { parentId } : {}),
})

describe('agents-panel', () => {
  test('keeps first-seen time and stamps the end once', async () => {
    const first = merge([], [agent('a', 'running')], 1000)
    expect(first[0]?.firstSeenAt).toBe(1000)
    expect(first[0]?.endedAt).toBe(null)
    const done = merge(first, [agent('a', 'completed')], 5000)
    expect(done[0]?.firstSeenAt).toBe(1000)
    expect(done[0]?.endedAt).toBe(5000)
    const later = merge(done, [agent('a', 'completed')], 9000)
    expect(later[0]?.endedAt).toBe(5000)
  })

  test('keeps an agent the engine dropped, as completed', async () => {
    const first = merge([], [agent('a', 'running')], 1000)
    const gone = merge(first, [], 2000)
    expect(gone[0]?.status).toBe('completed')
    expect(gone[0]?.endedAt).toBe(2000)
  })

  test('orders children under their parent, active first', async () => {
    const rows = merge([], [agent('done', 'completed'), agent('p', 'running'), agent('c', 'running', 'p')], 1000)
    const tree = ordered(rows).map(({ row, depth }) => `${row.id}:${depth}`)
    expect(tree).toEqual(['p:0', 'c:1', 'done:0'])
  })
})
