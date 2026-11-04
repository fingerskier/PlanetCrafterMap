import { describe, expect, it } from 'vitest'
import { COORD_LIMIT, formatHud, frameToBounds, fromLatLng, parseCoordInput, toLatLng } from '../src/lib/coords.js'

describe('toLatLng / fromLatLng', () => {
  it('maps x to lng and z to lat', () => {
    expect(toLatLng(12.5, -40)).toEqual([-40, 12.5])
    expect(fromLatLng({ lat: -40, lng: 12.5 })).toEqual({ x: 12.5, z: -40 })
  })

  it.each([
    [0, 0],
    [221, 432],
    [-865.25, -419.75],
    [3000, -2000],
  ])('round-trips (%d, %d)', (x, z) => {
    const [lat, lng] = toLatLng(x, z)
    expect(fromLatLng({ lat, lng })).toEqual({ x, z })
  })
})

describe('frameToBounds', () => {
  it('returns [[minZ, minX], [maxZ, maxX]]', () => {
    expect(frameToBounds([-2000, -1000, 3000, 4000])).toEqual([[-1000, -2000], [4000, 3000]])
  })

  it('agrees with toLatLng on the corners', () => {
    const frame = /** @type {[number, number, number, number]} */ ([-4600, -200, 1900, 6300])
    const [sw, ne] = frameToBounds(frame)
    expect(sw).toEqual(toLatLng(frame[0], frame[1]))
    expect(ne).toEqual(toLatLng(frame[2], frame[3]))
  })
})

describe('parseCoordInput', () => {
  it.each([
    ['221:12:432', { x: 221, y: 12, z: 432 }],
    ['-865:88:-419', { x: -865, y: 88, z: -419 }],
    ['1.5,2.25,-3.75', { x: 1.5, y: 2.25, z: -3.75 }],
    ['10 20 30', { x: 10, y: 20, z: 30 }],
    ['10;20;30', { x: 10, y: 20, z: 30 }],
    ['  -865 : 88 : -419  ', { x: -865, y: 88, z: -419 }],
    ['-865, 88, -419', { x: -865, y: 88, z: -419 }],
    ['1\t2\n3', { x: 1, y: 2, z: 3 }],
    ['[12.5, 30.1, -40.2]', { x: 12.5, y: 30.1, z: -40.2 }],
    ['(1;2;3)', { x: 1, y: 2, z: 3 }],
    ['+5:.5:5.', { x: 5, y: 0.5, z: 5 }],
    ['1e2:0:-1e2', { x: 100, y: 0, z: -100 }],
  ])('three numbers %j are X:Y:Z', (input, expected) => {
    expect(parseCoordInput(input)).toEqual(expected)
  })

  it.each([
    ['100 -200', { x: 100, y: null, z: -200 }],
    ['100,-200', { x: 100, y: null, z: -200 }],
    ['100:-200', { x: 100, y: null, z: -200 }],
    [' 100 ;  -200 ', { x: 100, y: null, z: -200 }],
  ])('two numbers %j are X Z', (input, expected) => {
    expect(parseCoordInput(input)).toEqual(expected)
  })

  it('normalizes -0 to 0', () => {
    const r = parseCoordInput('-0:-0:-0')
    expect(Object.is(r?.x, 0) && Object.is(r?.y, 0) && Object.is(r?.z, 0)).toBe(true)
  })

  it.each([
    '',
    '   ',
    '12',
    '1:2:3:4',
    'abc',
    'x,y,z',
    '1,2,z',
    '0x10:0:0',
    'Infinity:0:0',
    'NaN 0',
    '1..2 3',
    '1-2 3',
    '12abc 3',
    '1,,',
    '[1, 2',
    '((1,2))',
    `${COORD_LIMIT * 10} 0`,
    '1e400 0',
  ])('rejects %j', (input) => {
    expect(parseCoordInput(input)).toBeNull()
  })

  it.each([null, undefined, 42, {}, ['1', '2']])('rejects non-string %j', (input) => {
    expect(parseCoordInput(input)).toBeNull()
  })

  it('round-trips with formatHud for integer positions', () => {
    const hud = formatHud(-865, 88, -419)
    expect(parseCoordInput(hud)).toEqual({ x: -865, y: 88, z: -419 })
  })
})

describe('formatHud', () => {
  it('uses the HUD order X:Y:Z with rounded integers', () => {
    expect(formatHud(123.4, 45.5, -678.6)).toBe('123:46:-679')
    expect(formatHud(221, 12, 432)).toBe('221:12:432')
  })

  it('never prints -0', () => {
    expect(formatHud(-0.4, -0, -0.2)).toBe('0:0:0')
  })

  it('shows a missing altitude as ?', () => {
    expect(formatHud(10, null, -20)).toBe('10:?:-20')
    expect(formatHud(NaN, 1, Infinity)).toBe('?:1:?')
  })
})
