import { nanoid } from 'nanoid'

const ADJ = ['Amber', 'Cobalt', 'Mossy', 'Velvet', 'Copper', 'Ivory', 'Indigo', 'Scarlet', 'Dusky', 'Golden']
const ANIMAL = ['Fox', 'Heron', 'Otter', 'Lynx', 'Moth', 'Wren', 'Badger', 'Ibis', 'Newt', 'Hare']

function randomName() {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${ANIMAL[Math.floor(Math.random() * ANIMAL.length)]}`
}

let cached: { clientId: string; name: string } | null = null
/* another tab renaming us lands here; everything else goes through setName */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'draft:clientId' || e.key === 'draft:name') cached = null
  })
}

/** Memoized: render paths call this per frame and per row, and each
 *  localStorage read is a synchronous storage lookup. */
export function getIdentity(): { clientId: string; name: string } {
  if (cached) return cached
  cached = readIdentity()
  return cached
}

function readIdentity(): { clientId: string; name: string } {
  let clientId = localStorage.getItem('draft:clientId')
  if (!clientId) {
    clientId = nanoid(12)
    localStorage.setItem('draft:clientId', clientId)
  }
  let name = localStorage.getItem('draft:name')
  if (!name) {
    name = randomName()
    localStorage.setItem('draft:name', name)
  }
  return { clientId, name }
}

export function setName(name: string) {
  cached = null
  localStorage.setItem('draft:name', name)
}
