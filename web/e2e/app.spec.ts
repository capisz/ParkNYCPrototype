import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { PNG } from 'pngjs'

const place = {
  properties: { label: 'EMPIRE STATE BUILDING, New York, NY, USA' },
  geometry: { coordinates: [-73.9857, 40.7484] },
}

const curbFeatures = [
  {
    id: 'curb-red', street: 'West 34 Street', status: 'cannot_park', color: '#d3232a', side: 'North',
    coordinates: [[-73.9875, 40.7477], [-73.9875, 40.7491]],
  },
  {
    id: 'curb-yellow', street: '5 Avenue', status: 'paid', color: '#f2c14e', side: 'East',
    coordinates: [[-73.9864, 40.7477], [-73.9864, 40.7491]],
  },
  {
    id: 'curb-green', street: 'East 33 Street', status: 'free', color: '#238b45', side: 'South',
    coordinates: [[-73.9852, 40.7477], [-73.9852, 40.7491]],
  },
  {
    id: 'curb-gray', street: 'Broadway', status: 'unknown', color: '#667085', side: 'West',
    coordinates: [[-73.9840, 40.7477], [-73.9840, 40.7491]],
  },
].map(item => ({
  type: 'Feature',
  id: item.id,
  geometry: { type: 'LineString', coordinates: item.coordinates },
  properties: {
    blockfaceKey: `M|${item.street}|E 33 STREET|E 34 STREET|${item.side}`,
    status: item.status,
    color: item.color,
    confidence: item.status === 'unknown' ? 0.1 : 0.95,
    coverage: item.status === 'unknown' ? 'none' : 'full',
    geometryValidated: item.status !== 'unknown',
    onStreet: item.street,
    fromStreet: 'East 33 Street',
    toStreet: 'East 34 Street',
    sideOfStreet: item.side,
    ruleSummary: item.status === 'unknown' ? 'Parking status is unknown; check posted signs.' : `${item.street} is classified for the complete interval.`,
    evidence: [],
    sourceVersion: 'test-run',
    sourceUpdatedAt: '2026-07-19T04:00:00.000Z',
    interpretationVersion: 'parking-rules-v3-public-reference',
    changes: [],
    nextChange: null,
    verifyPostedSigns: true,
  },
}))

const renderedColors = [
  { label: 'cannot park red', rgb: [0xd3, 0x23, 0x2a] },
  { label: 'paid yellow', rgb: [0xf2, 0xc1, 0x4e] },
  { label: 'free green', rgb: [0x23, 0x8b, 0x45] },
  { label: 'unknown gray', rgb: [0x66, 0x70, 0x85] },
]

function matchingPixels(image: PNG, target: number[], tolerance = 20): number {
  let count = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] < 220) continue
    if (target.every((channel, index) => Math.abs(image.data[offset + index] - channel) <= tolerance)) count += 1
  }
  return count
}

async function expectRenderedCurbColors(page: import('@playwright/test').Page) {
  const canvas = page.locator('.map canvas')
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toBeVisible()
  const image = PNG.sync.read(await canvas.screenshot())
  for (const color of renderedColors) {
    expect(matchingPixels(image, color.rgb), `${color.label} must be painted into the map canvas`).toBeGreaterThan(20)
  }
}

function planResponse() {
  return {
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    interval: { start: new Date(Date.now() + 3_600_000).toISOString(), end: new Date(Date.now() + 10_800_000).toISOString() },
    timezone: 'America/New_York', advisory: true,
    preferences: { allowPaid: true, allowGarages: true, maxWalkMinutes: 10, allowTransit: false, accessibleOnly: false },
    dataVersions: [{ dataset: 'geometry', datasetId: 'dot-approved-test', version: 'test-run', sourceUpdatedAt: '2026-07-19T04:00:00.000Z', state: 'fresh' }],
    availability: { free: 1, paid: 1, cannotPark: 1, unknown: 1 },
    options: [{
      id: 'rec-1', kind: 'curb', tier: 'paid', status: 'paid', title: '5 Avenue', subtitle: 'East side · East 33 to East 34',
      latitude: 40.7485, longitude: -73.9856, distanceMeters: 80, walkMinutes: 1, confidence: 0.95,
      coverage: 'full', score: 12, ruleSummary: 'Yellow means paid parking during this planned interval.',
      nextChange: null, sourceVersion: 'test-run', facility: null, transit: null,
    }],
    warnings: [],
    disclaimer: 'Advisory only. Verify posted signs.',
  }
}

function viewportResponse(
  features = curbFeatures,
  summary = { free: 1, paid: 1, cannotPark: 1, unknown: 1 },
) {
  return {
    type: 'FeatureCollection', returned: features.length, clipped: false, advisory: true,
    generatedAt: new Date().toISOString(),
    interval: { start: new Date(Date.now() + 3_600_000).toISOString(), end: new Date(Date.now() + 10_800_000).toISOString() },
    summary,
    features,
  }
}

function hydrantExclusion(longitude: number, latitude: number) {
  const radiusMeters = 4.572
  const latitudeDelta = radiusMeters / 111_320
  const longitudeDelta = radiusMeters / (111_320 * Math.cos(latitude * Math.PI / 180))
  const ring = Array.from({ length: 33 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2
    return [longitude + Math.cos(angle) * longitudeDelta, latitude + Math.sin(angle) * latitudeDelta]
  })
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { kind: 'hydrant_exclusion', radiusFeet: 15, approximate: true, curbLinked: false },
  }
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.route('https://tiles.openfreemap.org/styles/bright', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dbe8e0' } }] }),
  }))
  await page.route('**/api/v1/search/autocomplete**', route => route.fulfill({ json: { features: [place] } }))
  await page.route('**/api/v1/search?**', route => route.fulfill({ json: { features: [place] } }))
  await page.route('**/api/v1/plans', async route => {
    if (testInfo.title.includes('progress feedback')) await new Promise(resolve => setTimeout(resolve, 700))
    await route.fulfill({ json: planResponse() })
  })
  await page.route('**/api/v1/curb/viewport**', async route => {
    if (testInfo.title.includes('retry state')) {
      await route.fulfill({ status: 503, json: { error: 'curb_service_unavailable' } })
      return
    }
    if (testInfo.title.includes('progress feedback')) await new Promise(resolve => setTimeout(resolve, 700))
    await route.fulfill({ json: viewportResponse() })
  })
  await page.route('**/api/v1/hydrants/viewport**', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }))
  await page.route('**/api/v1/facilities**', route => route.fulfill({ json: { facilities: [] } }))
})

function localInput(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function planTrip(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Where are you going?' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Destination', exact: true }).fill('Empire State Building')
  await page.getByRole('option', { name: place.properties.label, exact: true }).click()
  const arrival = new Date(Date.now() + 3_600_000)
  const departure = new Date(Date.now() + 10_800_000)
  await page.getByLabel('Arrive at destination').fill(localInput(arrival))
  await page.getByLabel('Leave destination').fill(localInput(departure))
  await page.getByRole('button', { name: 'Find parking options' }).click()
}

test('plans a complete stay and exposes exact map semantics', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const plannerAccessibility = await new AxeBuilder({ page }).analyze()
  expect(plannerAccessibility.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([])
  await planTrip(page)
  await expect(page.getByRole('complementary', { name: 'Parking map controls' })).toBeVisible()
  await expect(page.getByText('Best parking lead', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '5 Avenue', exact: true })).toBeVisible()
  await expect(page.getByText('Planned parking window')).toBeVisible()
  await expect(page.locator('.map-action-stack button[title="Center best parking lead"]')).toBeVisible()
  await page.getByRole('button', { name: '← Results', exact: true }).click()
  await expect(page.getByText('Red means cannot park')).toBeVisible()
  await expect(page.getByText('Yellow means paid parking')).toBeVisible()
  await expect(page.getByText('Green means likely free · verify signs')).toBeVisible()
  await expect(page.getByText('Gray means unknown — check signs')).toBeVisible()
  await page.getByRole('button', { name: 'Curbs', exact: true }).click()
  await expect(page.getByText('1 cannot park', { exact: true })).toBeVisible()
  await expect(page.getByText('Visible map totals')).toBeVisible()
  await expect(page.getByText('1 cannot park • 1 paid • 1 likely free • 1 unknown')).toBeVisible()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expectRenderedCurbColors(page)
  const mapAccessibility = await new AxeBuilder({ page }).analyze()
  expect(mapAccessibility.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('map-half.png'), fullPage: true })
  await expect(page.getByRole('heading', { name: 'Visible curbs', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Expand parking panel', exact: true }).click()
  const paidCurb = page.getByRole('button').filter({ hasText: '5 Avenue' })
  await expect(paidCurb).toHaveCount(1)
  await paidCurb.click()
  await expect(page.getByRole('heading', { name: '5 Avenue', exact: true })).toBeVisible()
  await expect(page.getByText('Coveragefull')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('map-selected-curb.png'), fullPage: true })
  await page.getByRole('button', { name: 'Minimize parking panel' }).click()
  await expect(page.getByRole('button', { name: 'Open parking panel' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('map-minimized.png'), fullPage: true })
})

test('shows a retry state instead of substituting demo curbs', async ({ page }) => {
  await planTrip(page)
  await expect(page.getByText('Current curb guidance is unavailable. No preview streets were substituted.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
})

test('keeps typed destination submission usable when suggestions fail', async ({ page }) => {
  await page.route('**/api/v1/search/autocomplete**', route => route.fulfill({
    status: 503,
    json: { error: 'geosearch_unavailable' },
  }))
  await page.goto('/')

  await page.getByRole('combobox', { name: 'Destination', exact: true }).fill('Empire State Building')
  await expect(page.getByRole('alert')).toContainText('suggestions are temporarily unavailable')
  const submit = page.getByRole('button', { name: 'Find parking options' })
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByRole('complementary', { name: 'Parking map controls' })).toBeVisible()
})

test('keeps the destination planner vertically scrollable', async ({ page }) => {
  await page.goto('/')
  const planner = page.locator('.planner')
  await expect(planner).toBeVisible()
  const dimensions = await planner.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

  await planner.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => planner.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})

test('shows progress feedback while the plan and map data load', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Destination', exact: true }).fill('Empire State Building')
  await page.getByRole('option', { name: place.properties.label, exact: true }).click()
  const arrival = new Date(Date.now() + 3_600_000)
  const departure = new Date(Date.now() + 10_800_000)
  await page.getByLabel('Arrive at destination').fill(localInput(arrival))
  await page.getByLabel('Leave destination').fill(localInput(departure))
  await page.getByRole('button', { name: 'Find parking options' }).click()

  await expect(page.getByRole('status', { name: 'Building your parking plan' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Parking map controls' })).toBeVisible()
  // Fast compact responses can finish before the map controls render. The
  // blocking planner feedback above must appear, then the selected best option
  // must replace transient loading status with the actionable parking window.
  await expect(page.getByText('Planned parking window')).toBeVisible()
})

test('explains unresolved coverage without inventing parking options', async ({ page }) => {
  await page.route('**/api/v1/plans', route => route.fulfill({ json: {
    ...planResponse(),
    availability: { free: 0, paid: 0, cannotPark: 0, unknown: 4 },
    options: [],
    warnings: [{ code: 'curb_guidance_unknown', message: 'Nearby curb evidence is unresolved.' }],
  } }))

  await planTrip(page)
  await expect(page.getByText('No supported likely-free or paid options yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review all 4 curb references' })).toBeVisible()
})

test('keeps the map interactive and reuses parking geometry while zooming', async ({ page }) => {
  test.setTimeout(60_000)
  await planTrip(page)
  await page.getByRole('button', { name: '← Results', exact: true }).click()
  await page.getByRole('button', { name: 'Curbs', exact: true }).click()
  await expect(page.getByText('1 cannot park • 1 paid • 1 likely free • 1 unknown')).toBeVisible()
  await expect(page.getByTestId('loading-overlay')).toHaveCount(0)

  await page.unroute('**/api/v1/curb/viewport**')
  let redundantRequests = 0
  await page.route('**/api/v1/curb/viewport**', route => {
    redundantRequests += 1
    return route.fulfill({ json: viewportResponse() })
  })

  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  await zoomIn.click()
  await expect(page.getByTestId('loading-overlay')).toHaveCount(0)
  await zoomIn.click()
  await page.waitForTimeout(500)
  await expect(page.getByText('1 cannot park • 1 paid • 1 likely free • 1 unknown')).toBeVisible()
  expect(redundantRequests).toBe(0)
})

test('loads full curb evidence only when a compact map feature is selected', async ({ page }) => {
  const compactFeatures = curbFeatures.map(feature => ({
    ...feature,
    properties: {
      status: feature.properties.status,
      color: feature.properties.color,
      confidence: feature.properties.confidence,
      coverage: feature.properties.coverage,
      geometryValidated: feature.properties.geometryValidated,
      geometryBasis: feature.properties.status === 'paid'
        ? 'official_meter_blockface'
        : feature.properties.geometryValidated ? 'dot_approved_curb' : 'unvalidated',
      recommendationEligible: feature.properties.status === 'free',
      ruleSummary: feature.properties.ruleSummary,
      nextChange: feature.properties.nextChange,
      onStreet: feature.properties.onStreet,
      fromStreet: feature.properties.fromStreet,
      toStreet: feature.properties.toStreet,
      sideOfStreet: feature.properties.sideOfStreet,
    },
  }))
  await page.unroute('**/api/v1/curb/viewport**')
  await page.route('**/api/v1/curb/viewport**', route => route.fulfill({ json: viewportResponse(compactFeatures) }))
  let detailRequests = 0
  await page.route('**/api/v1/curb/curb-yellow?**', async route => {
    detailRequests += 1
    await new Promise(resolve => setTimeout(resolve, 250))
    await route.fulfill({ json: curbFeatures[1] })
  })

  await planTrip(page)
  await page.getByRole('button', { name: 'Curbs', exact: true }).click()
  await page.getByRole('button', { name: 'Expand parking panel', exact: true }).click()
  await page.getByRole('button').filter({ hasText: '5 Avenue' }).click()
  await expect(page.getByText('Reference only—not a recommendation.')).toBeVisible()
  await expect(page.getByText('Interpretationparking-rules-v3-public-reference')).toBeVisible()
  expect(detailRequests).toBe(1)
})

test('renders accessible red hydrant safety rings at close zoom', async ({ page }) => {
  await page.unroute('**/api/v1/curb/viewport**')
  await page.route('**/api/v1/curb/viewport**', route => route.fulfill({
    json: viewportResponse([curbFeatures[3]], { free: 0, paid: 0, cannotPark: 0, unknown: 1 }),
  }))
  await page.unroute('**/api/v1/hydrants/viewport**')
  let hydrantRequests = 0
  await page.route('**/api/v1/hydrants/viewport**', route => {
    hydrantRequests += 1
    return route.fulfill({ json: {
      type: 'FeatureCollection',
      source: 'NYCDEP Citywide Hydrants',
      advisory: 'Approximate safety reference. Verify the physical hydrant and curb.',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: place.geometry.coordinates },
          properties: { kind: 'hydrant' },
        },
        hydrantExclusion(place.geometry.coordinates[0], place.geometry.coordinates[1]),
      ],
    } })
  })

  await planTrip(page)
  await page.getByRole('button', { name: '← Results', exact: true }).click()
  await expect(page.getByText('Red ring: approximate 15 ft hydrant safety reference — verify the curb')).toBeVisible()
  await expect.poll(() => hydrantRequests).toBeGreaterThan(0)
  await page.waitForTimeout(400)

  const canvas = page.locator('.map canvas')
  const image = PNG.sync.read(await canvas.screenshot())
  expect(matchingPixels(image, [0xd3, 0x23, 0x2a]), 'hydrant safety ring must be painted into the map canvas').toBeGreaterThan(20)
})
